# Settlement audit — Phases 2–4, and the `AnnulGame` hole

Written 2026-09-06 against `MIGRATION_PLAN.md`, `src/escrow.rs`, `src/contract.rs`, `server/src/*`,
`frontend/src/utils/turnClock.ts`, `TRIAGE_2026-09-06.md`. No code changed.

**Verdict in one paragraph.** Phase 2 is sound and its remaining work is correctly scoped. Phase 3 as
written is not implementable safely, for one structural reason: the chain cannot verify a game, so every
"challenge → annul" path is a veto that costs nothing and pays the loser a refund. The `AnnulGame` loophole
is not a fourth item on the list — it is the same hole as the challenge window, and it has three doors,
not one. The forfeit design also reintroduces the exact exploit `escrow.rs` refused to allow (appraise
whoever was ahead when the room stalled). All of it resolves with one change: **the contract must know
whether a game has started, and after that point the only exits are an appraised settlement or unanimous
signed consent.** Details follow, then a refined roadmap.

---

## 1. Write the trust model down first

Nothing in the plan says who is trusted. The answer is: **the server operator is a trusted party.** The
chain sees an appraisal and a hash it cannot check; the operator's key sends them; the operator also owns
the treasury the subsidy flows to. That is a fine model for a game at this scale — it is how every
off-chain-game/on-chain-escrow product works — but every mechanism below only makes sense once it is
stated. A challenge window in an operator-trust model is a **fraud alarm and a dispute trigger**, not an
adjudication. Design it as that.

Two things follow immediately:

- **Sign every submission with the session key.** The `x/authz` session-key layer becomes dead for gameplay
  once the chain stops running rules; its new job is offline signatures on log entries (no gas, no prompt).
  A signed log is non-repudiable evidence in a dispute, and "the player disconnected at index N" becomes a
  provable claim rather than the operator's word. This also closes `trustClaimedIdentity` (#1210) with the
  same mechanism — hello carries a signed nonce, entries carry signatures.
- **Consent is cheap, so use it.** The plan says "no player signatures in the happy path" to avoid a UX
  prompt. A session key signs without a prompt. At game end, every client already computes the final state;
  have it sign the (appraisal, log-hash) tuple automatically and send it to the server. **N-of-N signatures
  → immediate payout, no window.** Only a missing signature opens the window. That is strictly better UX than
  a 48-hour wait for every game, and it removes the operator from the happy path entirely.

---

## 2. `AnnulGame` — three doors, one fix

`execute_annul_game` has two tiers, and Phase 3 proposes a third. All three are open to a losing player:

| Door | Who | Wait | Why it is open |
|---|---|---|---|
| Creator tier | room creator | **none** | The doc comment says "the creator gains nothing by annulling early — every player gets their own money back." True before the deal; **false the moment positions exist.** A losing creator annuls for a refund. Worse than the 48-hour door: no waiting, no counterparty. |
| Timeout tier | any player | 48 h since `last_action_timestamp` | Every writer of that field is an on-chain gameplay handler being retired (`trading.rs`, `hexmap.rs`, `operations.rs`, …). Under the new architecture **nothing bumps it after the last join.** So 48 h after the table fills, any player can annul a live game — and in Async mode (3-day allowances) that is most of the game's life. The valve was built for on-chain play; it is dangling now. |
| Challenge (proposed) | any client | the window | "A mismatch → annullable." The chain cannot tell a real mismatch from a lie, so a challenge is a free refund button for whoever is behind. |

**The fix is a lifecycle, not a rule.** Add a session state to `GameSession`:

```
Lobby ──Start──▶ Started ──Settle/Consent──▶ Settling ──window elapses──▶ Settled
  │                 │                              │
  │ creator annul   │ NO unilateral exit           │ bonded challenge → Disputed → operator/arbiter resolves
  │ joiner withdraw │ checkpoints land here         │
  ▼                 ▼                              ▼
Annulled        (see §3, §4)                    Settled | Annulled (unanimous only)
```

- **`Lobby`:** creator may annul (the original, valid use — nobody has a position). A joiner may withdraw
  their own ante rather than tearing down the table. `last_action_timestamp` semantics stay as they are.
- **`Start`:** sent by the operator key when the deal is dealt (index 0). Carries the roster; the contract
  checks it equals `player_addresses`. From here on, **`AnnulGame` is refused for everyone.** The only exits
  are appraised settlement, or `AnnulByConsent { signatures[] }` requiring **all** players — which is the
  clemency vote's "Scrap Game" carried on-chain by the one mechanism the chain can actually verify.
- **Replace the 48-hour valve with a checkpoint.** The risk it guards is real (operator vanishes → funds
  locked forever), but the remedy must be a *result*, not a refund. The operator posts a `Checkpoint
  { appraisal, log_hash, log_len }` at every OR-set boundary (~40 values, ~10–20 txs per game, paid from the
  treasury — this is what the subsidy is for). If no checkpoint or settle lands for a long liveness window
  (14–30 days), **any player may trigger settlement from the last checkpoint.** A game that dies with the
  operator ends at its last round boundary, appraised — which is exactly what the plan already says a
  breach does. Refund only if no checkpoint exists (the game never really started).

That closes all three doors with one predicate, and the Rust change is a state enum plus three handlers.
Note "the escrow barely changes" is true of `escrow.rs` and false of `contract.rs` — the session state
machine, settle, checkpoint, consent, and challenge entrypoints are a substantial contract revision, and it
must be deployed and exercised on testnet before Phase 4 touches anything.

---

## 3. The challenge window as designed is a loser's veto

Restate what a challenge can and cannot do under operator trust:

- It **can** prove the operator submitted a log hash the player's client does not hold, or an appraisal the
  player's replay does not reproduce. Both are checkable *off-chain* by anyone with the log.
- It **cannot** be adjudicated on-chain. There is no reducer there.

So a challenge must (a) cost something, and (b) route to a resolver, never to a refund:

- **Bonded.** Challenger posts a bond ≥ their ante. Frivolous challenge (resolver upholds the settlement)
  forfeits the bond to the pool. Upheld challenge returns the bond and the operator's settlement is replaced
  by the resolver's. This is the standard optimistic design and it is the *only* thing that makes "my client
  objected" costly to fake.
- **Resolver.** At MVP: the operator, publicly, with the signed log as evidence. Better: a 2-of-3 multisig
  (operator + two independent keys) that can post a corrected settlement or a consent annulment. Say which.
- **Window length is a parameter of mode.** 48 h is fine for Async. For a Live game where every client just
  auto-signed, there is no window at all (§1). Where one signature is missing in Live, 24 h is plenty.

---

## 4. Forfeit-while-ahead — the plan contradicts the escrow

`escrow.rs` line 21–23: appraising on a stall "would hand a real-JUNO prize to whoever happened to be ahead
when the room stalled, which is indistinguishable from a rage-quit exploit." Phase 3's breach rule: "the game
halts and the reducer appraises everyone at the current state." Under Execute Penalty the offender gets
their appraised share minus their ante. **If their lead exceeds their ante, disconnecting is profitable** —
and the moment to do it is the one they choose: right before a train rush bankrupts their corporation, right
after a dividend and before a competitor's. The bankruptcy analogy fails because bankruptcy is losing; a
timeout can be taken while winning.

Three rules fix it:

1. **Forfeit is a loss.** Offender's payout under Execute = 0. Their share of the pool is redistributed
   among the remaining players by appraisal. Now no timing of a disconnect ever pays more than playing on.
2. **Clemency caps at refund.** Grant Clemency = offender receives `min(appraised share, net ante)`. They can
   get their money back; they can never profit from absence. Majority of remaining roster, as planned.
3. **Appraise at the last completed round boundary, not the instant of breach.** The breach instant is
   chosen by the offender; a round boundary is not. Same snapshot the checkpoint posts (§2), so the
   contract already holds it.

Define the arithmetic exactly before writing it — the plan says "ante slashed and divided" *and* "everyone
receives appraised net worth," which double-counts: the offender's ante is already inside the pool being
appraised. With rule 1 there is nothing to slash; the offender's share is simply zero. Prove
`Σ payouts + dust == pool` in `Uint128` with a test, as the existing payout does.

**Griefing remains** (a hopeless player ends the game for everyone) and is not an economic exploit. The
derived-action machinery makes "player X is on autopilot: pass, withhold, no purchases" nearly free to add
later, but the forced-train-purchase/bankruptcy interactions are real scope. Defer; note it.

---

## 5. Clock and forfeit — traps in the mechanism itself

- **A forfeit is the first time-triggered derived action.** `nextDerivedAction` runs at submit; nobody
  submits while the offender is absent. The server needs a scheduler that appends `Forfeit { player, at }`
  when reserve hits zero, and that re-arms from the log after a restart. This is new machinery, not a
  reducer arm, and it needs the same "batch equals incremental" discipline as `RoomEngine`.
- **`turnClock.ts` attributes a gap to whoever acted next.** Correct for measurement, wrong for a forfeit —
  the player who never acts is not the next actor. The on-clock player must come from `actingAddress` /
  `turnAuthority`, including the consent cases (the *answerer* is on the clock during a pending offer).
- **Offer griefing.** If the answerer's clock runs during a pending private/train offer, an offerer can
  drain a rival's reserve one offer per turn. Pending offers need their own short deadline with auto-decline,
  and must not draw reserve.
- **Server outage burns the on-turn player's reserve.** Gaps are measured between `at` stamps; an outage is
  indistinguishable from thinking. Persist a heartbeat lease so restart can append a
  `ClockSuspended { from, to }` derived entry covering the down window. Plan text still says "`at` must be
  the Firestore server stamp" — stale; the server mints it now, which is fine under §1.
- **Mutual pause needs a ceiling.** Unanimous pause with no resume policy is a permanent freeze if one
  player never returns. Cap pause length; past the cap the pause requester's reserve resumes draining.
- **Reconnection is a fairness requirement once clocks exist**, not deferred infrastructure. "A dropped
  socket means a reload" is acceptable in a free game and is a reserve tax on bad connections in a money
  game.
- **2-player edge cases.** "Majority of remaining roster" with one remaining player is that player;
  "unanimous" is also that player. Fine, but state it, and make sure the offender does not vote.
- Collect clock data from **free** games before any money rides on the numbers. `turnClock.ts` already
  makes this free; three or four full games to macro 10+ before setting Async defaults.

---

## 6. Settlement state and race traps

- **`loadLog` unwired = a restart erases a money game.** P0 before any deposit. The append must be durable
  (Firestore write acked, or fsync) *before* the `applied` frame, or "the append is the commit point" is a
  claim about memory.
- **Idempotent settle.** Server crashes after broadcasting `Settle` but before recording the tx hash;
  restart resubmits. `Settling` state refuses the second. Same for `Checkpoint` (carry `log_len`; refuse a
  shorter one).
- **Race: `Settle` vs `AnnulGame` in the same block window.** Closed by §2 (annul refused after `Start`);
  otherwise whichever tx lands first wins, and a losing creator will make sure it is theirs.
- **The log hash covers too little.** "Ordered concatenation of `payload` strings" omits `actor`, `at`,
  `derived`, and `index`. The clock reads `at`; the forfeit reads `actor`; the reducer reads `derived`. An
  operator could alter timestamps without changing the hash. Hash every field the reducer *or the clock*
  reads: `(index, actor, at, derived, payload)`. Pin with a constant-hash test, as planned. The `(index, id)`
  Firestore tie-break is dead on the server path — the server allocates indices.
- **Pin the reducer version per room.** `SetupGame` should carry the build id, and the server must settle a
  room with the reducer that dealt it. Otherwise a deploy mid-game changes the outcome of a game in
  progress, and a client on the old build "challenges" a correct settlement. (`build-skew` handles the
  wire; it does not handle a rule change.)
- **Roster from chain, not from the room doc.** The plan's own rule: "no rule may be decided from the room
  document." The deal is a rule. `SetupGame` must seat exactly the addresses that deposited into `game_id`,
  read from chain state, and `Start` must assert equality. A seat that never anted, or an ante that never
  got a seat, is otherwise possible.
- **Undo needs consent in a money game.** #1220's recorded gap says any player may send `RevertTo` at any
  time. That is parity with Firestore and fatal with money. Gate it: only the author of the reverted action,
  only when nothing by another player follows it, and add a unanimous-consent variant for anything deeper.
  This belongs in §3.2 and must close before the first deposit.
- **`total_vgp == 0` locks funds.** `finalize_and_distribute_payouts` returns `Err` when everyone is
  bankrupt. Today the creator can annul out of it; after §2 nobody can. Fall back to an equal split of the
  pool in that branch.
- **`settle` must carry `log_len`** so a client distinguishes "I am missing the last derived entries" from
  a real hash mismatch — the game-end derived action lands after the last player action, and a client that
  dropped its socket at the end will otherwise file a false challenge.
- **Sybil / collusion** (one person, two seats) cannot be prevented on-chain. Not worth engineering; worth a
  line in the rules.

---

## 7. Phase 2 completion — fine, with prerequisites promoted

The nine remaining retirements in §3.1's order are right. But `TRIAGE §3.2` and `§3.3` are labelled
"deferred infrastructure"; four of those items are Phase 3 prerequisites and should be renamed as such:
durable log + restart rebuild, real identity, reconnection, and the `RevertTo` / shell-message gate. None
of them is a settlement feature; all of them are things a settlement is built on.

Two smaller audit items already noted in the plan and worth closing in the same pass: `LoggedMsg` union
(#530), and `private_purchase_offer.price` number vs `train_purchase_offer.price` string.

---

## 8. Phase 4 — harvest, but triage first

`src/tests.rs` is 17.5k lines and only part of it is 1830. Triage by module before mining:
`trading`, `operations`, `hexmap`, `pathfinding`, `market`, `auction`, `waterfall`, `train_trade`, `or_phase`
are rules and worth harvesting; `contract`, `gamelog`, `escrow`, `query` are on-chain plumbing (authz,
`PassTurn` index, `reapply_game_log`) and mostly dead by construction. Keep `escrow`'s tests — they move to
the new contract. Do not gut anything until the §2 contract has settled at least one real game.

---

## 9. Refined roadmap

```
Phase 2   (as planned)  nine shell-message retirements → §3.1 order.

Phase 2.5 "money-ready" — all of these before the first ujuno deposit:
          a. durable log, write-before-ack, loadLog on restart
          b. session-key signature on hello and on every entry; retire trustClaimedIdentity
          c. reconnection with catch-up (baseIndex already exists)
          d. RevertTo consent gate; close #1220's shell-message gap; roster from chain in SetupGame
          e. reducer build id in SetupGame; server pins it per room
          f. log hash over (index, actor, at, derived, payload); constant pinned by test
          g. clocks in FREE games: time-triggered Forfeit entry, on-clock from turnAuthority,
             ClockSuspended on restart, offer deadlines, pause cap. Collect data.

Phase 3a  contract: session lifecycle (Lobby/Started/Settling/Disputed/Settled/Annulled),
          Start, Checkpoint, Settle, SettleByConsent(N-of-N sigs), AnnulByConsent(N-of-N),
          bonded Challenge, liveness settle-from-checkpoint, total_vgp==0 fallback.
          Testnet deploy. Retire creator-annul-after-start and the 48h valve.
Phase 3b  server: Start at deal, Checkpoint at OR-set boundaries, Settle at game end,
          collect client signatures for the consent fast path. Client: verify hash + appraisal,
          auto-sign, challenge UI (export-your-own-log is a prerequisite here, not §6).
Phase 3c  forfeit + clemency, with §4's arithmetic, after 3a/3b have settled real games and
          2.5g has produced clock data.

Phase 4   triage tests.rs by module → harvest rules modules → gut. Only after 3b settles a real game.
```

Order 2.5 before 3a. Every item in 2.5 is verifiable in the existing harness; nothing in 3a is until the
server it talks to is durable and authenticated.

---

## 10. Things the roadmap does not mention

- **Who pays gas for what.** Operator: Start, Checkpoint, Settle. Player: deposit, withdraw, challenge
  bond, consent signatures (offline, free). Feegrant from the treasury covers the player txs — confirm the
  subsidy at 400-tx sizing is now oversized for ~5 player txs per game and re-derive the fee.
- **Contract migration.** The new contract is a new `contract.rs` state machine; use CosmWasm `migrate`
  or a fresh instantiate and say which, since `GameSession` gains a state field.
- **Every player must be able to export their own log** (§6 in the plan). Under §3 it is the only evidence
  a challenger has. Not optional.
- **Chat on Firestore** is the last cross-dependency; fine to leave, but a money game's dispute evidence
  should not depend on a service that timed out mid-playtest last week.
- **Terms.** A bonded challenge, a forfeit, and an operator-resolved dispute are rules players agree to.
  They need to be readable in the lobby before the deposit, not discoverable after.
