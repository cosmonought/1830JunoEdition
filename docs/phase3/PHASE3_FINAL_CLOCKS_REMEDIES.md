# Phase 3 — final Live / Async clocks, pauses, trade timing, overdue, remedies and the FP4 server / UI

Branch `phase3/preplaytest-final-clocks-remedies` (from `3fecd54`; reference source only:
`phase3/preplaytest-live-async-clocks` @ `8559393`). Source, tests and docs only: nothing deployed, no AWS, Juno or
JUNOX mutation, no production KMS key, the escrow contract unchanged (`git diff 3fecd54 -- contracts` is empty).

This is the design record of what the branch implements. Server code: `server/src/rooms/clock/` (`clockModel.ts` the
pure state machine, `clockController.ts` its runner inside each game's serialization, `clockRecord.ts` the durable
record, `clockEvidence.ts` the evidence chain, `clockStore.ts` / `aws/game/dynamoClockStore.ts` the stores,
`clockWiring.ts` the one wiring both storage modes use), `server/src/escrow/remedyPipeline.ts` (FP4), the room-host and
game-server seams. Browser: `frontend/src/utils/clockProtocol.ts`, `gameClockView.ts`, `components/GameClockChip.tsx`,
the deadline choice, the No-deadline notice and the REMEDY-APPROVE signing in `money/`.

## 1. Responsibility model (one derivation)

`frontend/src/gameEngine/clockResponsibility.ts` derives, from a committed board, the ONE human who owes the next
required decision (`requiredDecisionOf`: a turn, an auction bid or pass, the B&O par, a train discard, an answer to a
standing offer -- off-turn answers included) and the standing offer (`standingOfferOf`: train, private purchase,
funding offer, private trade; its proposer and answerer). The timer, the UI and the remedy evidence all read this one
derivation. Refused, stale or duplicate submissions are never batches and never reach the clock; chat, reconnects,
opening UI and spectators are not moves. The M&H exchange (`ExchangePrivate`) is OPTIONAL: it neither refreshes a
clock nor cures an overdue.

## 2. Live timing state machine

- **20:00 per required action.** An accepted required action that leaves the same human owing the next decision gives
  them a fresh 20:00; one that hands responsibility on gives the new human a fresh 20:00. Another seat's accepted move
  that leaves the obligation where it was changes nothing.
- **Live inter-player offers (owner ruling, 2026-10-06).** A valid offer that puts its proposer in a WAITING state --
  the proposer was the responsible player, its clock running, and the board now owes the answer to another seat (a
  train offer; equally a private purchase, a funding offer or a private trade made on the proposer's own clock) --
  freezes the proposer's clock at its exact remainder and gives the answerer a distinct **10:00 response timer**: never
  an action clock, an overdue or a strike. A Live train offer always runs it (the owner's original rule). An offer that
  suspends nothing of its proposer's (an off-turn proposer, an offer made TO the responsible player, an offer to
  oneself) is not this mechanism: the answer is an ordinary required decision under the responsibility model, and it
  is never counted as a decline. An ACCEPT is progress (fresh 20:00 for the next decision); a REJECTION or an
  unanswered **expiry** resumes the proposer's EXACT remainder; the proposer's own RESCISSION is charged the time the
  answerer's timer actually ran (never a pause or an outage). At 10:00 the SERVER closes the offer as the proposer's
  rescission of THAT offer (`RescindTrainPurchase`, `RescindPrivatePurchase`, `RescindFundingPrivateOffer`,
  `RescindPrivateTrade`), stamped at the exact moment, in the game's own task; an expiry is an undo fence.
- **Two directional declines per Operating Round (Live only).** A rejection or an unanswered expiry of a qualifying Live
  offer is one DECLINE for its direction A -> B in the current Operating Round -- ONE counter per direction (`from>to`),
  whatever the offer's kind, once per offer (an answer undone and given again is the same decline). After two, A cannot
  make another qualifying offer to B that OR (the train's pre-speculation check uses the owner's sentence "B has
  declined two train offers from you this operating round."; every kind is checked after speculation against the
  answerer the board names, before commit, "B has declined two offers from you this operating round."). The next OR
  clears it; B -> A, A -> C and ordinary play stay open; an acceptance, a rescission or a genuine counter /
  continuation (a new offer replacing the standing one) is no decline. The engine allows one standing offer at a time
  and the answerer can only answer it, so no counter-offer arises in practice.
- **No offer count, no history bound.** No number of offers per round and no game-history length ever makes an offer
  illegal (owner ruling: the earlier 16-proposal budget and the "no new offer past 5,000 entries" refusal are
  removed). Offer CHURN is bounded only as transport: a per-seat, per-game offer-FREQUENCY bucket
  (`RoomLimits.offersPerSeat`, burst 10, then one every 10 s) answers the ordinary `rate-limited` with its
  `retryAfterMs`, after which the same offer is taken. The general limits are unchanged (submits per seat: burst 20, then
  3 a second; per game: burst 30, then 10 a second; the revert budget; the LIVE-2 log cap of 10,000 entries with its
  alarm at 5,000 -- the alarm only logs).
- **Overdue (strikes 1 and 2).** At 20:00 the seat is OVERDUE at that exact moment: its durable strike count rises and a
  10:00 cure / resolution window runs to minute 30. Gameplay is INTERRUPTED: only the overdue seat's own owed action
  is taken, and that action CURES (its strike stays; its next decision starts fresh). An overdue seat's own offer is
  refused (it cannot cure). Someone else's accepted move that leaves the seat owing nothing moots the instance. A cure
  posts a fencing checkpoint (money).
- **N-1 vote.** A non-defaulting seat proposes foreclosure (its own YES); every other non-defaulting seat must say YES.
  A single NO vetoes the proposal (the UI says so); abstention is incomplete; completion does NOT execute early. At
  minute 30 an uncured seat's game ends: foreclosure if a complete N-1 approval stands whose money approvals all outlive
  the attested finality by 300 s, otherwise the neutral timeout annulment. A cure at 29:59.999 beats a finality at
  30:00 (one judging instant per task; `due <= at`).
- **Third expiry.** The third ordinary expiry ends gameplay at once by foreclosure (remedy 3: challengeable on chain;
  gameplay is never reopened). No cure window, no vote, no neutral default.
- **Undo.** An undo restores the obligation from the snapshot taken before the undone batch -- never a fresh allowance.
  A seat undoing its OWN action is charged everything since it took it, whoever held the clock meanwhile (an
  act-handoff-undo-redo cycle can never stall the next seat). No undo while a seat is overdue, none across a fence (a
  cure, an expiry, a pause, a system pause, a credited outage, a recovered gap); declines and strikes never go back.

## 3. Pauses and continuity

- **Voluntary pause (Live).** Every seated player's YES to begin and every seated player's YES to end; it freezes
  whatever timer runs (action, response or cure window) exactly. Pause requests are bounded per obligation (16);
  resume requests are never refused outright (past a burst of 16 in one pause, one a minute).
- **System pause -- only while the game is PLAYABLE (owner ruling, 2026-10-06).** Every clock write stamps this process's AUTHORITY (file mode `file:<lock instance>`; AWS
  `aws:<generation>:<pool>:<epoch>:<task>`) and its trust instant; a running clock re-proves continuity by heartbeat
  (Live 10 s, Async 5 min) and continuity counts only when DURABLE (a heartbeat whose write did not land proves
  nothing). On load, before ordinary gameplay, timer advance or remedy signing: a record written by another authority,
  or a running clock not proven for 6 heartbeats (a stall, a store outage, a hold lifted), is a continuity break that
  was NOT proven. Live: **SYSTEM PAUSE** -- no vote to enter, every timer frozen as of the last proven instant,
  not-yet-final votes staled, no move until every seated player resumes (each YES names the break it saw, `since`).
  The owner's copy: "Game paused because server continuity was interrupted." / "All players must agree to resume."
  This applies to a Live game that still has playable state -- an overdue whose remedy is not yet sealed included (its
  cure window is frozen and a not-yet-final N-1 vote is staled). Timed Async: the outage is credited (timers resume as
  of the last proof, running from this server's start). A gap the record never folded is recovered from the log, never
  handing out fresh time. There is no owner-visible outage-duration threshold.
- **After a terminal seal: no pause, no vote.** Once the game has ENDED and its FP4 remedy is durably sealed there is no
  gameplay to resume: a continuity break (restart, takeover, AWS outage) pauses nothing and asks no player anything. An
  outage interrupts only the technical submission. On recovery the controller -- as the table's current authority --
  carries the SAME sealed remedy on automatically: the pipeline revalidates, at every attempt, the fence and ownership
  (only the clock's current authority; a stale actor, taken over, runs no task and writes nothing), the exact sealed
  evidence (its document folds to the sealed `evidence_hash`, ends with the `remedy-sealed` event naming exactly this
  decision, and carries the strike ledger whose head that event signs), the FP4 intents (an intent counts as this
  decision's only if it carries the same evidence hash and final moment), the REMEDY signature and key registry, the
  contract and game state, and expiry / freshness. An attestation that expired during the outage is ATTESTED AGAIN for
  the same decision (the protocol's own recovery: a fresh `attested_at`, the same decision digest) and submitted. The
  remedy is never changed, recalculated or converted; gameplay never reopens; the defaulting player gets no cure; no new
  foreclosure vote is collected. Strike 3 stays gameplay-terminal and the on-chain challenge window remains the
  defaulter's protection; a sealed first / second-overdue TimeoutAnnul or N-1 foreclosure continues only that outcome.
  **Owner decision required (stop condition):** escrow 2.1.0 checks every seat approval's `approve_until` against the
  BLOCK time and under the seat's CURRENT consent key. A sealed N-1 remedy (Live foreclosure 2; Async 4 / 5) whose
  approvals lapse (Live: about 5.5 h after finality with the browser's 6-hour horizon; Async: 29 days) or whose approving
  seat rotates its consent key before it lands can no longer land, and no re-attestation can revive an approval. The
  branch then HOLDS the same sealed decision unchanged (`refused`, "owner decision required", the seats named;
  `remedyBlocked`) -- no conversion to the neutral annulment and no re-vote, the earlier fallback and re-approval paths
  are removed -- and reports it for an owner decision. Remedies 1 and 3 carry no approvals and always recover.
- **Held / frozen tables.** A LIVE-3C held, incompatible or unreconciled table runs no clock task (held time becomes a
  continuity break when the hold lifts). A table at the ingress log cap is FROZEN: its timers stop for good; its votes,
  annulment and sealed remedies carry on.
- **Durability.** Evidence events and effects (the reporting hook, the ops audit, the fencing checkpoint) are carried
  out only once their record is STORED; a move is judged only against a stored clock; a read failure refuses rather
  than fabricating; a record another authority wrote stops this process deciding the table.

## 4. Timed Async and No-deadline

- **Timed Async.** The host chooses 12 h, 24 h, 2 d, 3 d or 7 d before play (a money table at creation, its escrow
  funded under that exact allowance); frozen at the deal. Same responsibility rules; no 20:00 and no special response
  timer (an offer's answerer owes an ordinary pace obligation; a rejection resumes the proposer exactly). **No decline
  limit** (owner ruling, 2026-10-06): Timed Async and No-deadline accumulate no rejection or expiry strikes for
  negotiation and never block a later legal offer because earlier ones were declined. Expiry marks
  OVERDUE only: no money moves, no grace, no interruption, possibly indefinitely. The other N-1 may unanimously propose
  neutral annulment or foreclosure; a NO vetoes; completion is FINAL at once (money: remedies 4 / 5); a cure first
  moots it. Money approvals must outlive the completion by an hour; one that lapsed or whose consent key moved BEFORE
  completion is set aside and its seat asked again. After sealing nothing is re-voted (§3).
- **No-deadline.** No clock, no overdue, ever. A money table's host acknowledges the disclosure with the create and
  every joiner before their deposit (persisted per player per table; deposits refused without it): "This game has no
  action deadline. If it does not finish and all players do not agree to annul it, your escrowed funds may remain
  locked indefinitely."
- **Universal unanimous annulment.** A free table annuls by every seat's YES in any live state (`clock-annul`); a money
  table annuls through its escrow (including a DISPUTED 2.1 game, the bond returned).
- **Exceptional review.** Distinct from the clock: any seated wallet may ask the resolver (once); no sooner than 7 days
  later the resolver may only annul neutrally; No-deadline keeps a high bar. A later recorded round withdraws the
  request (the contract's rule), and the copy says so.

## 5. Clock evidence format

`clockEvidence.ts`: flat events (integers and short strings; no float, secret, wallet proof or signature -- an approval
is evidenced by its seat, horizon and the SHA-256 of its signature); canonical JSON (sorted keys, no whitespace);
chain `head_0 = SHA-256("18COSMOS/CLOCK-EVIDENCE/v1/genesis" || game_id)`,
`head_n = SHA-256("18COSMOS/CLOCK-EVIDENCE/v1" || head_{n-1} || canonical(event_n))`. The record keeps the window since the
defaulting obligation began (with the head before it) and a never-reset **strike ledger** (every overdue and cure, its
own chain from `"18COSMOS/CLOCK-EVIDENCE/v1/strike-ledger/genesis" || game_id`). A sealed remedy carries both; its
`remedy-sealed` event names the ledger head, so the attested `evidence_hash` (the main head after the seal) commits to
every strike it relies on. Every durable event is offered to the reporting hook (`ClockConductHook`) with the head after
it -- the player-reporting lane's interface (that branch is not merged here).

**Storage is independent of the game history's length.** The evidence chain hashes every clock fact; the record keeps
only a bounded, CHECKPOINTED window: the events since the current obligation's responsibility event (reset by each new
obligation while nothing is overdue), at most `CLOCK_EVIDENCE_WINDOW` = 512 -- past that the oldest are folded into the
window's starting head (`window_from`, `truncated: true`), so the window still folds to the chain head and a sealed
document still folds to its attested hash -- and the strike ledger's newest 64 events (a Live game has at most five per
seat). Every event also goes, as it happens, to the reporting hook and the ops audit (the archive). A long negotiation
does not grow the window (each qualifying offer and each resumption starts a responsibility event). Nothing here
depends on the 5,000-entry figure: the stalled position (`log_len`, `log_hash`) is the full history's, and a remedy
sealed after more than 5,000 entries verifies the same way (`clockModel.test.ts`: 5,200 entries of negotiation, then a
sealed N-1 remedy; and a window past 512 events, checkpointed). Authoritative gameplay history is never compacted or
discarded; the LIVE-2 ingress cap (10,000 entries) is the general transport bound it always was, and a table that
reaches it is FROZEN (timers stop; votes, annulment and a sealed remedy carry on).

## 6. FP4 signing and intent flow

clock decision (inside the game's task) -> sealed remedy (durable record) -> `remedyPipeline.attest`: FP4 progress
first; a DEDICATED REMEDY signer (absent: every remedy refused, fail closed; the settlement signer never substitutes);
the escrow verified, the game bound, not held, not in restore safe mode; quorum chain reads (game, REMEDY key registry,
block time); the decision must still apply (IN_PROGRESS, `timed_remedy_v1`, the funded allowance, no remedy yet, no
checkpoint past the stall; a remedy on chain is ours only by digest); the SEALED decision revalidated against its own
evidence first (`sealedRemedyProblem`); every approval re-verified under the CURRENT consent keys (one that can no
longer land holds the sealed decision unchanged for an owner decision -- never converted, never re-voted); the
attestation built only from the sealed decision (whole seconds rounded up, attested at the quorum block time, one-hour
expiry; an expired one is attested again for the same decision), signed, verified, written as ONE durable intent
behind the per-game fence -> the relayer submits only on the clock lane's word (`remedyGate`: only an ENDED game's
sealed decision, only an intent carrying its evidence hash, never from a non-current authority, never while an
annulment is open or the table held; never gated by a player vote; an attempt signed earlier but unanswered is
re-broadcast only on that word). **Timed money fails closed without the dedicated REMEDY signer (owner, 2026-10-06):**
a timed (Live or Async-pace) money table is refused at creation and its join admission (the deposit's approval) is
refused when no REMEDY signer is configured; the settlement signer never substitutes; public browsing, Watch, free
tables and No-deadline money tables are unaffected. No payout is computed by the server or the browser.

## 7. UI

One clock chip in the room strip: the mode ("Live", "Async · 24 hours", "No deadline"), who acts, one countdown counted
by monotonic time since the view arrived (none on a tab that is not current); "Train offer — m:ss to respond" (or
"Offer — m:ss to respond" for another qualifying Live offer) with the proposer's paused clock shown inline; OVERDUE with the time to 30:00, the cure, the vote's status and the automatic
outcome (one countdown); "1 of 2 overdue cures used" after a first cure and the second-strike warning inline; a
voluntary pause told apart from a SYSTEM pause (preserved timer shown before anyone votes; never on an ended game, which
offers no vote of any kind); Async OVERDUE with no
countdown; the host's deadline chooser; the No-deadline notice before the ante; the money panel's exceptional review
(confirmation, neutral-annul-only copy, high bar for No-deadline). A money YES is signed on this device with the seat's
key (never the selected Keplr wallet) only after a confirmation naming the defaulting player and the outcome.

## 8. Residuals and owner decisions

- **Owner rulings applied (policy correction, 2026-10-06):** Live inter-player waiting offers use the 10:00 response
  timer; two directional declines per OR apply to Live only; Async (Timed and No-deadline) has no decline limit; there
  is no 16-offer gameplay cap; there is no 5,000-history gameplay prohibition; system pause / unanimous resume applies
  only while playable state remains; an already-sealed terminal FP4 remedy resumes technical processing after
  infrastructure recovery without player consent; timed money remains fail-closed without the remedy signer.
- **OWNER DECISION REQUIRED -- a sealed N-1 remedy whose approvals can no longer land.** See §3: escrow 2.1.0 offers no
  recovery for a lapsed approval or a rotated approving key (re-attestation cannot extend `approve_until`); the only
  routes would be a new set of seat signatures (a new vote -- refused by the ruling) or another outcome (a conversion --
  refused by the ruling). The branch holds the decision unchanged and surfaces it ("waits for the operator's
  decision"); the money stays in escrow under the contract's own paths (unanimous annulment, the exceptional review).
  A key rotation between an N-1 completion and Live minute 30 can seal such a decision too (completion already sets
  aside votes found stale).
- **Still applied beyond the brief's letter (owner may revise):** the proposer's own rescission is charged the
  answerer's run time (so propose-and-rescind cannot stop the proposer's clock).
- **Transport residual:** with no offer count, offer churn can still grow a game's log toward the LIVE-2 cap (10,000)
  at the frequency limit -- in Live the proposer's own clock is charged for propose-and-rescind and the two-decline
  rule bounds rejections; in Async a churning seat can add about 720 entries an hour. A table at the cap is frozen
  (timers stop), as before this lane. Raising or redesigning the general log cap is outside this correction.
- Live outages and stalls under about 60 s are charged (the continuity limit); host undo on FREE tables can hand the
  host a fresh clock (money tables have `host_undo: "none"`); a confederate Async answerer can sit up to its pace per
  offer; a recovered gap may misread an offer and its answer that both fall inside it (conservative: no fresh time); a
  failed write right after a unanimous resume can re-pause once; a resolver's annulment of a challenged third strike is
  not reflected in the chip's ended label; the browser does not check `logLen` / `logHash` against its own log before
  signing; a failed chain-start read at the deal leaves the first obligation unclamped; `CLOCK_VERSION` 2 is this
  branch's final shape (no earlier v2 record was persisted outside tests; a record written by the pre-correction build
  with an `offers` field is unreadable by this one -- never deployed).
- **Not done here (by the brief):** 2.1 is not deployed; the canonical 2.1 checksum is not certified; no KMS remedy
  signer is deployed; nothing is mainnet ready.

## 9. Tests

Server (node:test): `rooms/clock/clockModel.test.ts` (the owner's matrix on controlled time; the policy correction's
Live-offer, Async, no-cap, no-history-bound, evidence-bound and post-terminal-outage rows), `clockController.test.ts`
(a real engine session: train and private-purchase offers, expiry, declines before commit, Async, stalls, holds,
outages, durability, takeovers), `clockServer.test.ts` (the real server: restart under a new authority, pauses, Async,
No-deadline, annulment, offer frequency as transport), `escrow/remedyPipeline.test.ts` and `fp4RemedyIntents.test.ts`
(FP4 end to end on the fake chain, the gate, approvals, key rotation, sealed-evidence revalidation, a takeover with no
pause or vote, an attestation expired during an outage attested again after the restart), `escrow/clockMoney.test.ts`
(money deadlines, acknowledgements, timed money fail-closed without the REMEDY signer), `persistence/conformance/clockStore.conformance`
(file and DynamoDB Local). Browser (Jest): `utils/gameClockView.test.ts`, `components/gameClockChip.test.tsx`,
`components/clockDeadlineUi.test.tsx`, `money/clockMoney.test.ts`.
