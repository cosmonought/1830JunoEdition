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
- **Train (and every Live) offer.** A valid offer whose answerer is someone else freezes the proposer's clock at its
  exact remainder and gives the answerer a distinct **10:00 response timer** -- never an action clock, an overdue or
  a strike. The owner's rule names train offers; the branch applies the same response timer to private, funding and
  private-trade offers so an answerer can never pick the proposer's overdue moment (review finding). An ACCEPT is
  progress (fresh 20:00 for the next decision); a REJECTION or an unanswered **expiry** resumes the proposer's EXACT
  remainder; the proposer's own RESCISSION is charged the time the answerer's timer actually ran (never a pause or an
  outage). At 10:00 the SERVER closes the offer as the proposer's rescission of THAT offer (`RescindTrainPurchase`,
  `RescindPrivatePurchase`, `RescindFundingPrivateOffer`, `RescindPrivateTrade`), stamped at the exact moment, in the
  game's own task; an expiry is an undo fence. An offer to oneself parks nothing and refreshes nothing until accepted.
- **Anti-spam.** A rejection or an expiry is one DECLINE for its direction in the current Operating Round, counted per
  offer kind (`from>to` for Live trains -- the owner's counter, shown on the table; `<kind>:from>to` for the other Live
  kinds; `async-<kind>:from>to` for Async), once per offer (an answer undone and given again is the same decline). Two
  block a third proposal of that kind in that direction until the next OR, with the owner's sentence ("B has declined
  two train offers from you this operating round."); A -> C, B -> A and ordinary play stay open. Live trains are
  checked before speculation; every kind is checked after speculation against the answerer the board names, before
  commit. An **offer budget** of 16 proposals per seat per round (any round type) bounds offer churn; an undo never
  refunds it. Past the ingress log alarm (5,000 entries) no new offer is taken.
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
- **System pause.** Every clock write stamps this process's AUTHORITY (file mode `file:<lock instance>`; AWS
  `aws:<generation>:<pool>:<epoch>:<task>`) and its trust instant; a running clock re-proves continuity by heartbeat
  (Live 10 s, Async 5 min) and continuity counts only when DURABLE (a heartbeat whose write did not land proves
  nothing). On load, before ordinary gameplay, timer advance or remedy signing: a record written by another authority,
  or a running clock not proven for 6 heartbeats (a stall, a store outage, a hold lifted), is a continuity break that
  was NOT proven. Live: **SYSTEM PAUSE** -- no vote to enter, every timer frozen as of the last proven instant,
  not-yet-final votes staled, no move until every seated player resumes (each YES names the break it saw, `since`).
  The owner's copy: "Game paused because server continuity was interrupted." / "All players must agree to resume."
  Timed Async: the outage is credited (timers resume as of the last proof, running from this server's start). An
  ENDED Live game whose sealed money remedy is not final on chain is system-paused too: nothing not final is attested
  or relayed until every player resumes; anything final on chain before the outage stays final. A gap the record never
  folded is recovered from the log, never handing out fresh time. There is no owner-visible outage-duration threshold.
- **Held / frozen tables.** A LIVE-3C held, incompatible or unreconciled table runs no clock task (held time becomes a
  continuity break when the hold lifts). A table at the ingress log cap is FROZEN: its timers stop for good; its votes,
  annulment and sealed remedies carry on.
- **Durability.** Evidence events and effects (the reporting hook, the ops audit, the fencing checkpoint) are carried
  out only once their record is STORED; a move is judged only against a stored clock; a read failure refuses rather
  than fabricating; a record another authority wrote stops this process deciding the table.

## 4. Timed Async and No-deadline

- **Timed Async.** The host chooses 12 h, 24 h, 2 d, 3 d or 7 d before play (a money table at creation, its escrow
  funded under that exact allowance); frozen at the deal. Same responsibility rules; no 20:00 and no special response
  timer (an offer's answerer owes an ordinary pace obligation; a rejection resumes the proposer exactly). Expiry marks
  OVERDUE only: no money moves, no grace, no interruption, possibly indefinitely. The other N-1 may unanimously propose
  neutral annulment or foreclosure; a NO vetoes; completion is FINAL at once (money: remedies 4 / 5); a cure first
  moots it. Money approvals must outlive the completion by an hour; one that lapsed or whose consent key moved is set
  aside and its seat asked again (after sealing: `remedyStale` / `clock-reapprove` / reseal of the SAME decision).
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

## 6. FP4 signing and intent flow

clock decision (inside the game's task) -> sealed remedy (durable record) -> `remedyPipeline.attest`: FP4 progress
first; a DEDICATED REMEDY signer (absent: every remedy refused, fail closed; the settlement signer never substitutes);
the escrow verified, the game bound, not held, not in restore safe mode; quorum chain reads (game, REMEDY key registry,
block time); the decision must still apply (IN_PROGRESS, `timed_remedy_v1`, the funded allowance, no remedy yet, no
checkpoint past the stall; a remedy on chain is ours only by digest); every approval re-verified under the CURRENT
consent keys (Live: a lapsed or moved approval falls back to the neutral annulment; Async: those seats renew); the
attestation built only from the sealed decision (whole seconds rounded up, attested at the quorum block time, one-hour
expiry), signed, verified, written as ONE durable intent behind the per-game fence -> the relayer submits only on the
clock lane's word (`remedyGate`: never under a system pause, never from a non-current authority, never while an
annulment is open or the table held; an attempt signed earlier but unanswered is re-broadcast only on that word). Timed
money tables are refused at creation and join admission when no REMEDY signer is configured. No payout is computed by
the server or the browser.

## 7. UI

One clock chip in the room strip: the mode ("Live", "Async · 24 hours", "No deadline"), who acts, one countdown counted
by monotonic time since the view arrived (none on a tab that is not current); "Train offer — m:ss to respond" with the
proposer's paused clock shown inline; OVERDUE with the time to 30:00, the cure, the vote's status and the automatic
outcome (one countdown); "1 of 2 overdue cures used" after a first cure and the second-strike warning inline; a
voluntary pause told apart from a SYSTEM pause (preserved timer shown before anyone votes); Async OVERDUE with no
countdown; the host's deadline chooser; the No-deadline notice before the ante; the money panel's exceptional review
(confirmation, neutral-annul-only copy, high bar for No-deadline). A money YES is signed on this device with the seat's
key (never the selected Keplr wallet) only after a confirmation naming the defaulting player and the outcome.

## 8. Residuals and owner decisions

- **Owner decision (recorded, brief-literal):** an ENDED Live game whose remedy is not final on chain needs EVERY
  seat's resume after a break, so the defaulter can withhold it; the exceptional review is the backstop. Likewise any
  restart system-pauses active Live games and one player can refuse to resume.
- **Applied beyond the brief's letter, for abuse resistance (owner may revise):** the 10:00 response timer and the
  two-decline limit for every Live offer kind (the brief names train offers); decline limits for Async offers; a
  proposer's rescission charged the answerer's run time; the offer budget; offers refused past the log alarm.
- Live outages and stalls under about 60 s are charged (the continuity limit); the engine has no train counter-offer
  (the "counter is not a decline" rule has nothing to apply to); host undo on FREE tables can hand the host a fresh
  clock (money tables have `host_undo: "none"`); a confederate Async answerer can sit up to its pace per offer (bounded
  by declines and the budget); a recovered gap may misread an offer and its answer that both fall inside it
  (conservative: no fresh time); a failed write right after a unanimous resume can re-pause once; a resolver's
  annulment of a challenged third strike is not reflected in the chip's ended label; the browser does not check
  `logLen` / `logHash` against its own log before signing; a failed chain-start read at the deal leaves the first
  obligation unclamped; an Async remedy waits for every stale seat's renewal; `CLOCK_VERSION` 2 is this branch's final
  shape (no earlier v2 record was persisted outside tests).
- **Not done here (by the brief):** 2.1 is not deployed; the canonical 2.1 checksum is not certified; no KMS remedy
  signer is deployed; nothing is mainnet ready.

## 9. Tests

Server (node:test): `rooms/clock/clockModel.test.ts` (the owner's matrix on controlled time), `clockController.test.ts`
(a real engine session: offers, expiry, stalls, holds, outages, durability, takeovers), `clockServer.test.ts` (the real
server: restart under a new authority, pauses, Async, No-deadline, annulment), `escrow/remedyPipeline.test.ts` and
`fp4RemedyIntents.test.ts` (FP4 end to end on the fake chain, the gate, approvals, key rotation),
`escrow/clockMoney.test.ts` (money deadlines and acknowledgements), `persistence/conformance/clockStore.conformance`
(file and DynamoDB Local). Browser (Jest): `utils/gameClockView.test.ts`, `components/gameClockChip.test.tsx`,
`components/clockDeadlineUi.test.tsx`, `money/clockMoney.test.ts`.
