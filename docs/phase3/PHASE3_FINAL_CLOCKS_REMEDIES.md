# Phase 3 — final Live / Async clocks, pauses, trade timing, overdue, remedies and the FP4 server / UI

Branch `phase3/preplaytest-final-clocks-remedies` (from `3fecd54`; reference source only:
`phase3/preplaytest-live-async-clocks` @ `8559393`). Source, tests and docs only: nothing deployed, no AWS, Juno or
JUNOX mutation, no production KMS key. **The escrow 2.1.0 contract SOURCE changed in the last owner correction
(2026-10-07)**: seat approvals are judged at the sealed decision's `final_at` (§3), with an uncapped retired-key
history and a `ConsentKeyAt` query. No signed byte, gameplay rules version or settlement codec changed. Any earlier
noncanonical 2.1 Wasm hash is SUPERSEDED: the owner-machine canonical Wasm certification must build the final contract
HEAD of this branch.

**INTEGRATED (2026-10-07):** this branch's head `5fc690e` is the base of the consolidated final pre-playtest integration,
`phase3/consolidated-final-preplaytest-integration` (not merged to main; nothing deployed; escrow 2.1.0 still NOT deployed, NOT
certified, NOT canonical). There the reporting hook (`ClockConductHook`, below) is CONSUMED by player reporting (P3-N035):
`server/src/conduct/conductClockFacts.ts` keeps a bounded per-game feed of the hook's events, and a report attaches the
server's clock facts (responsibility, offers, rejects, expiries, freeze exhaustion, overdue, cure, strike, foreclosure
proposal, votes, pauses, system pause, remedy finality; the sealed remedy's own evidence after a seal) with no signature,
approval, wallet proof, key or secret -- it reads the clock record and the feed and duplicates no clock state machine. The
integration also holds the fail-closed rule at the host's own ante and the Start (no REMEDY signer: a timed money table is
neither funded nor started) and treats the clock as held while a restored money table's restore check is pending.

This is the design record of what the branch implements. Server code: `server/src/rooms/clock/` (`clockModel.ts` the
pure state machine, `clockController.ts` its runner inside each game's serialization, `clockRecord.ts` the durable
record, `clockEvidence.ts` the evidence chain, `clockStore.ts` / `aws/game/dynamoClockStore.ts` the stores,
`clockWiring.ts` the one wiring both storage modes use), `server/src/escrow/remedyPipeline.ts` (FP4), the room-host and
game-server seams. Browser: `frontend/src/utils/clockProtocol.ts`, `gameClockView.ts`, `components/GameClockChip.tsx`,
the deadline choice, the No-deadline notice and the REMEDY-APPROVE signing in `money/`.

**Authoritative owner rulings recorded here (last correction, 2026-10-07):**

1. Remedy approvals are valid through the REMEDY SEAL, not through the later landing: an approval valid at the sealed
   decision's finality -- its horizon after `final_at`, signed under the consent key its seat held at `final_at` --
   decides that decision, whatever later expiry, key rotation, outage or delayed submission follows.
2. A sealed remedy is immutable: no new vote, no alternate remedy, no cure, no reopening; a re-attestation carries only
   the exact same sealed decision (the same `final_at`).
3. There is NO arbitrary gameplay-history hard cap: no number of log entries makes a game unplayable, frozen or refused.
4. Optional offers never refresh the required-action allowance (Live and Timed Async).
5. The Live two-decline limit resets per ROUND INSTANCE: each operating sub-round (OR 2.1 and OR 2.2 are two) and,
   for offers legal in a Stock Round, each Stock Round instance -- derived from the board's own round identity.
6. **Live optional-offer freeze budget (2026-10-07):** "Each fresh Live required-action episode includes at most 10
   minutes TOTAL of optional inter-player offer freeze protection. Once that budget is exhausted, further legal offers
   remain permitted but the proposer's ordinary action clock continues running." The 20-minute per-action clock, the
   10-minute individual response timer, the per-round-instance two-decline rule and the Async continuous deadline are
   kept; the freeze budget is independent of the declines.

## 1. Responsibility model (one derivation)

`frontend/src/gameEngine/clockResponsibility.ts` derives, from a committed board, the ONE human who owes the next
required decision (`requiredDecisionOf`: a turn, an auction bid or pass, the B&O par, a train discard, an answer to a
standing offer -- off-turn answers included) and the standing offer (`standingOfferOf`: train, private purchase,
funding offer, private trade; its proposer and answerer). The timer, the UI and the remedy evidence all read this one
derivation. Refused, stale or duplicate submissions are never batches and never reach the clock; chat, reconnects,
opening UI and spectators are not moves. The M&H exchange (`ExchangePrivate`) is OPTIONAL: it neither refreshes a
clock nor cures an overdue. The ROUND INSTANCE (`roundInstanceKeyOf`) is `current_round_type / macro_round_number /
sub_round_index` of the committed (or speculated) board -- never client timing.

## 2. Live timing state machine

- **20:00 per required action.** An accepted REQUIRED action that leaves the same human owing the next decision gives
  them a fresh 20:00; one that hands responsibility on gives the new human a fresh 20:00. Another seat's accepted move
  that leaves the obligation where it was changes nothing.
- **Live qualifying offers: the answerer has 10:00; the proposer is frozen only within its FREEZE BUDGET (owner
  rulings, 2026-10-06 and 2026-10-07).** A valid offer that puts its proposer in a WAITING state -- the proposer was the
  responsible player, its clock running, and the board now owes the answer to another seat (a train offer; equally a
  private purchase or a private trade made on the proposer's own clock) -- PARKS the proposer's remainder and gives the
  answerer a distinct **10:00 response timer**: never an action clock, an overdue or a strike. A Live train offer always
  runs it. An offer that suspends nothing of its proposer's (an off-turn proposer, a funding offer made TO the
  responsible player, an offer to oneself) is not this mechanism and is never a decline.
  **The freeze budget.** Every fresh Live required-action episode -- a fresh 20:00 -- carries **10:00 TOTAL** of
  optional-offer freeze protection (`freeze_ms` on the action obligation; `LIVE_FREEZE_BUDGET_MS`), cumulative across
  EVERY qualifying offer made while that same required action remains owed: never 10:00 per offer, never replenished
  by an acceptance, a rejection, an expiry, a counter or a withdrawal. A park carries the budget left when it parked;
  the answer's wait W is measured by the answerer's RESPONSE timer (so a voluntary pause, a system pause or an outage
  consumes nothing) and, with F the budget left, the first min(F, W) is FROZEN (the proposer's clock does not move) and
  everything beyond F is CHARGED to the proposer's clock. Owner example: A has 14:20; offer 1 waits 4:00 -> 14:20, budget
  6:00; offer 2 waits 6:00 -> 14:20, budget 0:00; a further offer is LEGAL (never refused for an exhausted budget) and
  A's clock runs while it waits. With 8:00 and 2:30 left, a 7:00 wait is frozen for 2:30 and charged 4:30. If the
  proposer's OWN clock runs out strictly before the answerer's response time does, the SERVER closes the offer at that
  moment (the proposer's rescission, message class `server-close`: an undo fence, NO decline) and the proposer is
  OVERDUE under the ordinary Live rules (a strike, the cure window); the answerer is never struck and its response timer
  never becomes an overdue clock (at an exact tie the unanswered expiry decides: a decline). **Resolution:** whatever
  closes the offer -- an ACCEPTANCE, a REJECTION, an unanswered EXPIRY (10:00, a decline), a counter / continuation, the
  proposer's own WITHDRAWAL -- a proposer that still owes the SAME required decision resumes the same episode: its
  remainder less the charged part of the wait, with the budget left (a withdrawal now draws on the budget like every
  other resolution, replacing the interim rule that charged it the whole wait). **Reset:** the budget is renewed ONLY by
  a genuinely new episode -- the required action completed and a further one owed (a legitimate fresh 20:00 for the
  same player), or responsibility genuinely passed (the new seat's own fresh episode); never by optional negotiation, an
  offer's outcome, a reconnect or reload, UI activity, a round-instance (OR / SR) boundary on its own, or an undo (§2
  Undo). At 10:00 unanswered the SERVER closes the offer as the proposer's rescission of THAT offer
  (`RescindTrainPurchase`, `RescindPrivatePurchase`, `RescindFundingPrivateOffer`, `RescindPrivateTrade`), stamped at the
  exact moment, in the game's own task; an expiry is an undo fence.
- **Two directional declines per ROUND INSTANCE (Live only).** A rejection or an unanswered expiry of a qualifying Live
  offer is one DECLINE for its direction A -> B in the CURRENT ROUND INSTANCE -- one counter per direction (`from>to`),
  whatever the offer's kind, once per PROPOSAL (identified by its position in the log, never by a board key that can
  repeat; an answer undone and given again is the same decline). The scope is the operating SUB-ROUND for offers made in
  an Operating Round (OR 2.1 and OR 2.2 are separate instances: A -> B may collect two declines in OR 2.1; OR 2.2 starts
  from zero) and that Stock Round instance for offers legal in a Stock Round (the next Stock Round starts from zero) --
  never the whole set of Operating Rounds; nothing leaks between instances (a batch that passes several empty sub-rounds
  re-scopes once; an undo of the round-ending move restores the earlier instance's counts). After two, A cannot make
  another qualifying offer to B in that instance (the train's pre-speculation check uses the owner's sentence "B has
  declined two train offers from you this operating round." -- "this operating round" being the current operating
  sub-round; every kind is checked after speculation against the answerer the board names, before commit). B -> A,
  A -> C and ordinary play stay open; an acceptance, a rescission or a counter / continuation is no decline.
- **No offer count, no history bound.** No number of offers per round and no game-history length ever makes an offer or
  a move illegal (owner rulings: the 16-proposal budget, the "no new offer past 5,000 entries" refusal and the LIVE-2
  10,000-entry cap and freeze are all removed; nothing replaces them -- §5a). Offer CHURN is bounded only as transport:
  per-seat, per-game offer-FREQUENCY buckets (`RoomLimits.offersPerSeat`: burst 10, then one every 10 s;
  `offersPerSeatSustained`: 30, then 30 an hour) answer the ordinary `rate-limited` with its `retryAfterMs`, after which
  the same offer is taken; only an offer that LANDS spends them. The general submit limits and the revert budget are
  unchanged; the 5,000-entry log ALARM only logs.
- **Overdue (strikes 1 and 2).** At 20:00 the seat is OVERDUE at that exact moment: its durable strike count rises and a
  10:00 cure / resolution window runs to minute 30. Gameplay is INTERRUPTED: only the overdue seat's own owed action
  is taken, and that action CURES (its strike stays; its next decision starts fresh). An overdue seat's own offer is
  refused (it cannot cure). Someone else's accepted move that leaves the seat owing nothing moots the instance. A cure
  posts a fencing checkpoint (money).
- **N-1 vote and minute 30 (money: approvals judged AT finality).** A non-defaulting seat proposes foreclosure (its own
  YES); every other non-defaulting seat must say YES. A single NO vetoes; abstention is incomplete; completion does NOT
  execute early. At minute 30 an uncured seat's game ends: foreclosure if a complete N-1 approval stands whose money
  approvals are VALID AT FINALITY -- each horizon strictly after the attested final second (no relay margin), and each
  signed under the consent key its seat held AT that second -- otherwise the neutral timeout annulment. The keys at the
  final second are read conclusively: by quorum, only once the chain has a block LATER than that second, and only from
  nodes answering at that block's height or later (`smartQuorumAtLeast`; a rotation stamped at or before the second
  voids that YES -- the consensus is then incomplete: the neutral outcome; one after it changes nothing). **Unread ->
  undecided (fail closed):** if the keys cannot be read conclusively (no quorum, no block past the second yet, a money
  table with no chain reader), minute 30 is NOT processed: every move and every vote is refused ("The 30-minute
  decision is waiting for Juno to confirm the approvals ...") until a read is conclusive, and the decision is then made
  AT ITS OWN MOMENT (the seal's `final_ms` is minute 30). A restart or takeover after minute 30 fell due never crosses
  it (no veto, no system pause: §3). A cure at 29:59.999 beats a finality at 30:00 (one judging instant per task;
  `due <= at`).
- **Third expiry.** The third ordinary expiry ends gameplay at once by foreclosure (remedy 3: challengeable on chain;
  gameplay is never reopened). No cure window, no vote, no neutral default.
- **Undo -- never time, never freeze budget.** An undo restores the obligation from the snapshot taken before the undone
  batch -- never a fresh allowance and never a fresh budget. A seat undoing its OWN action is charged everything since it
  took it, whoever held the clock meanwhile (an act-handoff-undo-redo cycle can never stall the next seat); undoing its
  own qualifying OFFER settles that offer's wait exactly as its withdrawal would (frozen within the budget left, charged
  beyond it). A restored Live park is SETTLED at the snapshot (the wait its response timer had measured, split into
  frozen and charged), charged its seat's own run since the undone batch, and never restored above what that seat holds
  NOW (its current clock and budget, or its current park as it stands); a restored response timer measures its wait
  afresh. So no undo -- the proposer's own, the answerer's undo of its own answer, a host's -- refunds clock or budget
  (fuzzed: a seat's clock + budget never rises while its clock runs). A restored Async park is restored as it stands (it
  kept running). No undo while a seat is overdue, none across a fence (a cure, an expiry or server close, a pause, a
  system pause, a credited outage, a recovered gap); declines and strikes never go back.

## 3. Pauses, continuity and the sealed remedy

- **Voluntary pause (Live).** Every seated player's YES to begin and every seated player's YES to end; it freezes
  whatever timer runs (action, response or cure window) exactly. Pause requests are bounded per obligation (16);
  resume requests are never refused outright (past a burst of 16 in one pause, one a minute).
- **System pause -- only while the game is PLAYABLE (owner ruling, 2026-10-06).** Every clock write stamps this
  process's AUTHORITY (file mode `file:<lock instance>`; AWS `aws:<generation>:<pool>:<epoch>:<task>`) and its trust
  instant; a running clock re-proves continuity by heartbeat (Live 10 s, Async 5 min) and continuity counts only when
  DURABLE. On load, before ordinary gameplay, timer advance or remedy signing: a record written by another authority,
  or a running clock not proven for 6 heartbeats, is a continuity break that was NOT proven. Live: **SYSTEM PAUSE** --
  no vote to enter, every timer frozen as of the last proven instant, not-yet-final votes staled, no move until every
  seated player resumes (each YES names the break it saw, `since`). The owner's copy: "Game paused because server
  continuity was interrupted." / "All players must agree to resume." This applies to a Live game that still has
  playable state -- an overdue whose minute 30 has not yet fallen due included. **A minute 30 that fell due WITHIN the
  proven continuity** (at or before the preserved instant: its keys unread, or its timer lost) is not crossed by the
  break: no veto, no pause -- it is decided at its own moment on the votes standing then. Timed Async: the outage is
  credited (the running clock and every running park resume as of the last proof). A gap the record never folded is
  recovered from the log, never handing out fresh time. There is no owner-visible outage-duration threshold.
- **After a terminal seal: no pause, no vote; the same remedy continues.** Once the game has ENDED and its FP4 remedy is
  durably sealed there is no gameplay to resume: a continuity break (restart, takeover, AWS outage) pauses nothing and
  asks no player anything; it interrupts only the technical submission. On recovery the controller -- as the table's
  current authority -- carries the SAME sealed remedy on automatically: the pipeline revalidates, at every attempt, the
  fence and ownership, the exact sealed evidence (its document folds to the sealed `evidence_hash`, ends with the
  `remedy-sealed` event naming exactly this decision, and carries the strike ledger whose head that event signs), the
  FP4 intents (an intent counts as this decision's only if it carries the same evidence hash and final moment), the
  REMEDY signature and key registry, the contract and game state, and expiry / freshness. An attestation that expired
  during the outage is ATTESTED AGAIN for the same decision (a fresh `attested_at`, the same `final_at`, the same
  decision digest) and submitted. The remedy is never changed, recalculated or converted; gameplay never reopens; the
  defaulting player gets no cure; no new vote is collected. Nobody needs to open the table (money games are loaded at
  startup; a table with an unfinished sealed remedy stays RESIDENT; an FP4 intent's end loads a table not open here).
- **Sealed approvals survive later expiry and key rotation (owner ruling, 2026-10-07; escrow 2.1.0 source).** The
  contract judges every REMEDY-APPROVE AT the attested `final_at`, never at the block time it lands in:
  `final_at < approve_until` (else `ApprovalExpired`) and the signature verifies under the key the seat held at
  `final_at` (`consent_key_at`: the current key, or -- for a `TimedRemedyV1` game rotated while IN_PROGRESS -- the key
  retired after `final_at`, from a separate uncapped history `retired_consent_keys` keyed `(game, seat, ordinal)` with
  each retirement's block time, compared in nanoseconds; read only by `SubmitRemedy` and the `ConsentKeyAt` query).
  The validity is bound to THE sealed finality event: the approval digest names the exact overdue instance (kind,
  strike, epoch, `log_len`, `log_hash`, `overdue_at`, seat) and the attestation's `final_at` is signed by the REMEDY
  key, which attests only a decision the clock sealed. Before the seal, expiry, rotation, cure and incomplete consensus
  still matter (each checked conclusively at the final second, above); after it, nothing revokes the decision. The
  REMEDY-APPROVE/v1 signed bytes are unchanged and no protocol version moved (no FP4 bump beyond protocol 4): only the
  instant the contract judges at changed, and no approval was ever signed under the old meaning (2.1.0 is not deployed).
  The pipeline attests an N-1 decision only once the chain has a block past `final_at` (its approvals' keys read at
  that second, at that height), and an intent's usable life is the attestation's own expiry. A sealed decision whose
  approvals the chain still refuses (defensive: the server seals only approvals conclusively valid at finality) is held
  UNCHANGED for an owner decision -- never converted, never re-voted.
- **Held tables.** A LIVE-3C held, incompatible or unreconciled table runs no clock task (held time becomes a continuity
  break when the hold lifts). There is no frozen-at-the-log-cap state any more (no cap).
- **Durability.** Evidence events and effects (the reporting hook, the ops audit, the fencing checkpoint) are carried
  out only once their record is STORED; a move is judged only against a stored clock; a read failure refuses rather
  than fabricating; a record another authority wrote stops this process deciding the table.

## 4. Timed Async and No-deadline

- **Timed Async.** The host chooses 12 h, 24 h, 2 d, 3 d or 7 d before play (a money table at creation, its escrow
  funded under that exact allowance); frozen at the deal. Same responsibility rules; no 20:00, no 10:00 response timer
  and **no decline limit** (owner ruling, 2026-10-06). The allowance refreshes ONLY when the required action is
  completed or responsibility genuinely passes. **Optional negotiation never refreshes, nor stops, the responsible
  player's deadline (owner ruling, 2026-10-07):** an offer that suspends the proposer's required decision parks its
  remainder RUNNING (`since`): the answerer owes an ordinary pace obligation, but the proposer's deadline keeps running
  (every tab is shown it: "Your deadline keeps running while the offer is answered: ... left (the offer is withdrawn
  when it runs out)"). Accepted, rejected or countered, the proposer resumes its deadline AS IT STANDS -- every hour
  the negotiation took is its own. The answer window never outlives the proposer's deadline: at that deadline the
  SERVER closes the offer (the proposer's rescission, stamped at that moment) and the proposer, owing its decision with
  nothing left, is OVERDUE at it (the answerer is never struck); a counter's answerer whose own deadline stands parked
  answers within what it has left. So colluding players cannot keep an Async deadline alive by trading offers -- the
  deadline is exact. Outages are credited to running parks as to the running clock. Expiry marks OVERDUE only: no money
  moves, no grace, no interruption, possibly indefinitely. The other N-1 may unanimously propose neutral annulment or
  foreclosure; a NO vetoes; completion is FINAL at once (money: remedies 4 / 5); a cure first moots it.
  **Money completion (owner ruling, 2026-10-07):** the YES that completes the set is decided AT the instant its whole
  set was confirmed -- every approval's horizon after that second and its signature under the key its seat held at
  that second, read conclusively (a block past it, at that height; up to 20 s) -- and only if nothing was recorded
  meanwhile (the evidence sequence); otherwise nothing is decided ("try again"). A completion reached without that
  check is refused. After sealing nothing is re-voted (§3).
- **No-deadline.** No clock, no overdue, ever. A money table's host acknowledges the disclosure with the create and
  every joiner before their deposit (persisted per player per table; deposits refused without it): "This game has no
  action deadline. If it does not finish and all players do not agree to annul it, your escrowed funds may remain
  locked indefinitely."
- **Universal unanimous annulment.** A free table annuls by every seat's YES in any live state (`clock-annul`); a money
  table annuls through its escrow (including a DISPUTED 2.1 game, the bond returned).
- **Exceptional review.** Distinct from the clock: any seated wallet may ask the resolver (once); no sooner than 7 days
  later the resolver may only annul neutrally; No-deadline keeps a high bar.

## 5. Clock evidence format

`clockEvidence.ts`: flat events (integers and short strings; no float, secret, wallet proof or signature -- an approval
is evidenced by its seat, horizon and the SHA-256 of its signature); canonical JSON (sorted keys, no whitespace);
chain `head_0 = SHA-256("18COSMOS/CLOCK-EVIDENCE/v1/genesis" || game_id)`,
`head_n = SHA-256("18COSMOS/CLOCK-EVIDENCE/v1" || head_{n-1} || canonical(event_n))`. The record keeps a bounded,
CHECKPOINTED window since the defaulting obligation's original grant (at most `CLOCK_EVIDENCE_WINDOW` = 512 events;
older ones folded into the window's starting head) and a never-reset **strike ledger** (its own chain; newest 64
events). A sealed remedy carries both; its `remedy-sealed` event names the ledger head, so the attested
`evidence_hash` commits to every strike it relies on. Every durable event is offered to the reporting hook
(`ClockConductHook`) with the head after it. The evidence is independent of the game history's length: the stalled
position (`log_len`, `log_hash`) is the full history's cumulative hash (§5a), and a remedy sealed past 10,000 entries
verifies the same way (`clockController.test.ts`: 10,200 entries; `clockModel.test.ts`: 5,200 entries and a window
past 512 events).

**Freeze-budget audit trail (Live).** `responsibility` carries `freeze_ms` -- a fresh episode's initial 10:00 (its
`reason` names the start: the deal, an accepted action, a handoff, a cure) or the budget a resumption carries on;
`trade-begin` carries the proposer's park (`parked_ms`) and the budget it parked with (`freeze_ms`); `trade-end` splits
the wait into `waited_ms`, `frozen_ms`, `charged_ms` and `freeze_left_ms` and names the result (`accept`, `reject`,
`expire`, `rescind`, `proposer-deadline`); `undo` names a restored park (`park_seat`, `park_ms`, `park_freeze_ms`). The
moment frozen time turned into charged time is the offer's start plus `freeze_ms` of response-timer run (pause and
system-pause events bound it). The remedy attestation's bytes are unchanged (only the evidence content, hashed into
`evidence_hash`, carries the new fields).

## 5a. History without a length limit (owner ruling, 2026-10-07)

- **No cap of any size.** The 10,000-entry refusal, the clock freeze at it and the 10,000,000 `baseIndex` transport
  bound are removed; nothing replaces them. Authoritative history is never truncated, compacted or dropped.
- **Storage (the existing segmented primitive).** DynamoDB keeps ONE ITEM PER ENTRY (`GAME#<g>` / `LOG#%010d`, the
  exact line the file store writes; batches as one transaction of at most `DYNAMO_LOG_MAX_BATCH` entries with the HEAD),
  so no item grows with the history; from index 10^10 the sort key widens to `LOG#~%016d`, which sorts after every
  ten-digit key (no stored key changes). The file store appends one line per entry. Loads are validated (contiguity,
  HEAD agreement, batch completeness) and read page by page (DynamoDB pages; the file in 16 MiB chunks) with each page --
  and the scan itself -- reported as progress, so the store deadline (`STORE_TIMEOUT_MS` = 5 s) bounds a page, never
  the whole history. A DynamoDB log is scanned line by line (`scanLogLines`, exactly `scanLog`'s answer) and exported as
  one Buffer -- never one joined string (V8's string ceiling); file reads have no single-read (2 GiB) ceiling
  (`readFileChunked`, also for deal identity and the doctors).
- **Cumulative hash / fence.** `logHash` is a streamed SHA-256 over every entry's line (the same digest as before);
  `cumulativeLogHash` keeps clonable checkpoints every `LOG_HASH_SEGMENT` = 4,096 entries and at the hot tip, anchored
  on the frozen entry OBJECT, and answers only for a server history (every entry has its id, strictly increasing), so
  the overdue's `log_hash`, the fence and the remedy evidence hash only the entries since the nearest checkpoint.
- **Catch-up in pages.** A client that says `pages: 1` in its hello receives a long history as consecutive pages of at
  most `CATCH_UP_PAGE_BYTES` = 512 KiB with backpressure (low water 1 MiB); nothing else for that socket comes between a
  catch-up's pages; the client reassembles them BEFORE judging the frame (the resync filter sees the whole catch-up)
  and the last page carries the digest, `inReplyTo` and `inFlight`. A legacy client still gets one frame. **Deploy the
  server before the bundle** (an older server refuses the new hello field).
- **Deterministic restart / replay.** A restarted server loads the whole history and replays it to the same board;
  the next move is appended past it (`rooms/longHistory.test.ts`: 10,400+ entries through the real server and file
  stores; `dynamoGame.conformance.test.ts`: 10,300 entries on DynamoDB Local).
- **Not implemented -- the bounded hot window (exact incompatibility).** `RoomSession` still holds every entry in memory
  and `restore` / `rebuild` (RevertTo) / `discardAfter` / `rollbackTo` replay from the seed; a bounded hot window needs a
  CERTIFIED ENGINE-STATE CHECKPOINT FORMAT bound to the cumulative hash that those paths can start from -- a
  hosted-protocol and replay-certification change, not a storage migration. Without it, costs grow with length
  (about 29 µs per entry to restore; a publish copies the committed view, O(n) per move), degrading play only at
  hundreds of thousands of entries; no move is ever refused for the history's length.

## 6. FP4 signing and intent flow

clock decision (inside the game's task) -> sealed remedy (durable record) -> `remedyPipeline.attest`: FP4 progress
first; a DEDICATED REMEDY signer (absent: every remedy refused, fail closed; the settlement signer never substitutes);
the escrow verified, the game bound, not held, not in restore safe mode; quorum chain reads (game, REMEDY key registry,
block time; for an N-1 decision the seats' keys AT its `final_at`, only once a block past it exists and from nodes at
that height or later -- otherwise it waits); the decision must still apply (IN_PROGRESS, `timed_remedy_v1`, the funded
allowance, no remedy yet, no checkpoint past the stall; a remedy on chain is ours only by digest); the SEALED decision
revalidated against its own evidence first (`sealedRemedyProblem`); every approval verified at `final_at` (horizon
after it, the key held then); the attestation built only from the sealed decision (whole seconds rounded up, attested
at the quorum block time, one-hour expiry; an expired one is attested again for the same decision), signed, verified,
written as ONE durable intent (usable until the attestation's expiry) behind the per-game fence -> the relayer submits
only on the clock lane's word (`remedyGate`). **Timed money fails closed without the dedicated REMEDY signer
(owner, 2026-10-06).** No payout is computed by the server or the browser.

## 7. UI

One clock chip in the room strip: the mode ("Live", "Async · 24 hours", "No deadline"), who acts, one countdown counted
by monotonic time since the view arrived (none on a tab that is not current); "Train offer — m:ss to respond" (or
"Offer — m:ss to respond" for another qualifying Live offer) with the proposer's own clock shown inline -- paused, with the offer pause left this action, while its freeze budget
lasts, then counting down beside the response timer ("... running while the offer waits: m:ss left (this action's
10:00 of offer pause is used up)"); a Live responsible seat's "offer pause left this action"; on a Timed
Async table the proposer's still-running deadline behind its offer (`running`); OVERDUE with the time to 30:00, the
cure, the vote's status and the automatic outcome (one countdown); "1 of 2 overdue cures used" after a first cure and
the second-strike warning inline; a voluntary pause told apart from a SYSTEM pause; Async OVERDUE with no countdown;
the host's deadline chooser; the No-deadline notice before the ante; the money panel's exceptional review. A money YES
is signed on this device with the seat's key (never the selected Keplr wallet) only after a confirmation naming the
defaulting player and the outcome.

## 8. Residuals and owner decisions

- **Owner rulings applied:** the six above (2026-10-07) and the policy correction's (2026-10-06): Live qualifying offers use
  the 10:00 response timer; Async has no response timer and no decline limit; no 16-offer cap; no 5,000-entry
  prohibition; system pause / unanimous resume only while playable state remains; an already-sealed terminal FP4 remedy
  continues automatically after infrastructure recovery; timed money fails closed without the remedy signer; transport
  offer-frequency limits stay as abuse protection only.
- **Resolved (owner ruling, 2026-10-07): Live accepted offers.** The exact freeze is bounded by the episode's 10:00
  freeze budget (§2): colluding offers -- accepted, rejected, withdrawn, expired, countered, undone -- extend one Live
  required-action episode by at most 10:00 of frozen time in all; then the proposer's own clock runs and, if it runs
  out while an offer waits, the proposer is overdue.
- **Minute 30 waits for the chain.** A Live money minute 30 whose keys cannot be read conclusively (Juno halted, no
  quorum, a lagging or height-silent node, the chain reader not yet opened) holds the table -- no move, no vote -- until
  they can; ops should alert on `finalityKeysUnread` (the warning is rate-limited).
- **Compromised REMEDY key.** Approvals being judged at the attested `final_at`, a compromised REMEDY key holding the
  approvals of a CURED instance could attest a back-dated `final_at < approve_until` until the fencing checkpoint past
  the stall lands; the cure posts it (`fenceCheckpoint`), but tracking it to landing is a residual of the clock lane
  (README security model updated).
- **Async remedies need every non-defaulting seat**, so a colluding answerer can block an N-1 against its partner (the
  owner's N-1 rule; unchanged).
- **Edges (LOW, never giving time):** a host undo of another seat's action restores an answerer's response timer
  charged a run it did not make; an offer resolved inside a recovered gap (a crash between commit and clock write) is
  settled at the gap's last stamp (its wait counted to then -- never less); a counter / continuation cannot arise today
  (one standing offer at a time), so the model's counter paths (each replaced offer's wait settled first) are tested
  only synthetically.
- **History costs (no cap):** see §5a's exact incompatibility; also a legacy (non-paging) client's single catch-up frame
  cannot exceed V8's string length (about 1.4 M entries) -- current bundles page; a client too slow to receive a huge
  catch-up before its socket drops starts it again; the first hash after a restart re-reads the whole history once
  (pure-JS SHA-256: about 10 s at 2 M entries); the dev `replayCli` still reads a whole file.
- **Rollback note.** `CLOCK_VERSION` is 3 (Async running parks, Live freeze budgets): an older build refuses a version-3
  record as NEWER (fail closed: money tables refuse moves; free tables play untimed). A version-2 record is carried
  forward once (a pre-correction Async park runs from its record's last write; a pre-budget Live obligation or park gets
  a full budget once); a version-3 record missing a field is unreadable, never guessed at.
- A truncated evidence document (more than 512 facts in one obligation) folds to its attested hash but its earliest
  facts are only in the best-effort archive; a lost clock record of a dealt money table starts a new clock (system
  paused).
- **Not done here (by the brief):** 2.1 is not deployed; the canonical 2.1 checksum is not certified (and any earlier
  noncanonical Wasm hash is superseded by this branch's final contract HEAD); no KMS remedy signer is deployed; nothing
  is mainnet ready.

## 9. Tests

Server (node:test): `rooms/clock/clockModel.test.ts` (the owner's matrix on controlled time: the Live FREEZE BUDGET --
basic (the owner's 14:20 example), partial (2:30 then a 7:00 wait), collusion (at most 10:00 per episode, nothing
replenishes it), reset (completed action, handoff; never an offer's outcome, a reload or a round-instance change),
overdue at the proposer's own deadline with the offer closed and no decline, pause / system pause / outage /
mid-offer reload exact, undo refunds nothing (self, answerer, host), gaps and counters settled, version-2 records;
Live offers resume the same remainder on accept / reject / expiry / counter, handoffs fresh; Async running parks, collusion with time passing, the
server's close at the proposer's deadline, outage credit; round-instance declines OR 2.1 vs 2.2 and SR instances; undo
of answers and rescissions; recovered gaps; minute 30 pending and not crossed by a restart), `clockController.test.ts`
(a real engine session: offers, expiry, the freeze budget used by an unanswered offer and a later offer closed at the
proposer's deadline through the engine, a reload renewing nothing, declines before commit, Async close at the deadline through the engine, money
minute 30 with keys moved / unread, the Async completion check, 10,200 entries), `clockServer.test.ts` (the real
server; a restart midway through an offer keeping the action, response and budget remainders exactly), `rooms/longHistory.test.ts` (10,400+ entries through the real server: playable, durable, hashed, reloaded,
replayed, paged catch-up; line-wise scan equivalence; chunked reads), `rooms/gameActor.test.ts` (paged load deadline,
no phantom timeout), `escrow/remedyPipeline.test.ts` and `fp4RemedyIntents.test.ts` (FP4 on the fake chain: approvals
at `final_at`, rotation before / at / after it, conclusive and height-pinned reads), `escrow/clockMoney.test.ts`,
`escrow/escrow3bAdversarial.test.ts` (reads at a known height), `persistence/conformance/clockStore.conformance` and
`dynamoGame.conformance` (DynamoDB Local; 10,300 entries; widened keys). Contract (cargo): `tests/remedy.rs`
(approvals judged at `final_at`; sealed decision survives later expiry and rotation; rotation at or before `final_at`
voids; never replaced), `tests/consent_key.rs` (uncapped history), `tests/invariants.rs` (fuzzer), `tests/remedy_vectors.rs`
(42 vectors, 41 replayed). Browser (Jest): `utils/gameClockView.test.ts`, `utils/serverLink.test.ts`,
`utils/logHash.test.ts`, `components/gameClockChip.test.tsx`, `components/clockDeadlineUi.test.tsx`,
`utils/escrowJunoRegressionOracle.test.ts`.
