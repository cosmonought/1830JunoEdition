# Decisions that are yours — 1830Juno, 6 September 2026

> **RESOLVED, same day.** The owner's answers, verbatim where they corrected an assumption:
>
> - **A1** Option 1 — the server settles automatically. **A2** Option 2 — session keys sign every move.
>   **A3** Option 2 — 14-day liveness window. **A4** Option 2 — consent fast path. **A5** bonded challenge,
>   resolved by the owner; 24 h Live / 48 h Async.
> - **A6 and B1 — correction:** *"There are no 'free' games. Every single game requires an on-chain ante,
>   even if we are playtesting with fake Testnet-JUNO. Drop the two-path logic; the chain deposit dictates
>   the roster 100% of the time. We will gather clock data from our sandbox playtests and Testnet
>   playtests."*
> - **A7 — correction:** *"In 1830, the game ends immediately when a single player goes bankrupt. Total
>   bankruptcy of the entire table is impossible under the rules."* And, on the ordering: *"a player going
>   bankrupt is part of their turn as corporation president. It happens BEFORE all other players are
>   scored, as the conclusion of the bankrupt player's turn."* The all-bankrupt fallback is withdrawn.
> - **A8** Option 2 — forfeit pays zero, clemency caps at refund, appraisal at the last round boundary.
> - **B2** Live and Async are room settings. **B3** delete the multi-train buy selector. **B4** retire the
>   Firestore room path after the next test. **B5** keep the client-side rules running for the alarm.
> - **C** confirmed; the owner drafts the Terms page.
>
> The implementation order these produce is in `MIGRATION_PLAN.md` under #1254. The text below is kept as
> the record of what was asked.

Everything the code can decide for itself has been decided. What is left needs you, because each one is a
call about money, trust or how the game should feel. For each: what the question is, the options, what each
costs, and what I would do. Where a default exists, I say what happens if you say nothing.

Order: the ones that block real money first, then the ones about the game, then the small ones.

---

## Part A — before anyone deposits a coin

### A1. Who do players trust? (the trust model)

**The question.** The chain cannot run the game rules. It sees only a hash and a payout list, sent by the
server's key. So somebody is trusted. Who?

**Options.**

1. **The server operator is trusted (you).** Standard for off-chain games with on-chain escrow. Everything
   else below is designed as alarms and evidence around that trust, not as a replacement for it.
2. **Nobody is trusted** — the chain verifies the game. Impossible here: it would mean the whole reducer
   on-chain again, which is what this migration is undoing.

**Consequence of (1).** It has to be written down where players see it: "the operator settles; here is how
you dispute." A dispute is a fraud alarm with evidence, not an appeal to a judge that does not exist.

**Recommendation.** Option 1, stated in the rules page. It is what we have been building anyway.

### A2. What is a player's identity? (signed entries, and retiring the "trust what the client says" server)

**The question.** Today the server believes any browser that says "I am p-alice". Fine at a kitchen table,
fatal with money. What proves a move came from a player?

**Options.**

1. **Wallet signs every move.** Airtight, and the wallet pops a prompt on every click. Unplayable.
2. **Session key.** The wallet authorises a throwaway key once per game (one prompt at sign-in); that key
   signs every move silently. The chain already knows this pattern (`x/authz`). A signed log then proves
   "player X made move N" and "player X went quiet at index M" without anybody's word for it. This is also
   what makes A4's consent fast path possible.
3. **Server-issued login token.** Simple, but the server can forge any player's moves, so the log proves
   nothing in a dispute. Only defensible if you are comfortable that the evidence trail is your word.

**Consequences.** (2) is real work: key issuance in the client, signature checks on hello and on every entry
in the server, the signature becomes part of the stored log. It also decides what a "player" IS for the
roster question (A6): a chain address. (3) is a week less work and a much weaker dispute story.

**Recommendation.** Option 2. If you say nothing, nothing changes: the insecure identity stays, and money
stays off.

### A3. How can a game end early? (the annul rules)

**The question.** Today the room creator can annul any time for a full refund, and *anyone* can annul after
48 quiet hours. Both were designed for on-chain play. Under the new architecture nothing bumps that 48-hour
timer after the deal, so in practice a losing player can wait two days and take their money back.

**Options.**

1. **Leave it.** A loss is refundable by walking away. Nobody who is winning would play for money.
2. **Lifecycle: after the deal, no unilateral exit.** Before the deal: creator may annul, a joiner may take
   their own ante back. After the deal: the only ways out are a settlement, or an annul that *every* player
   signs (the "scrap this game" vote, made real). To stop "operator vanishes, funds locked forever", the server
   posts a small checkpoint (appraisal + log hash) at every round boundary; if nothing lands for a long
   window (14–30 days), any player can trigger settlement *from the last checkpoint*. Refund only if no
   checkpoint ever existed.

**Consequences of (2).** A contract revision — a state machine plus a few new messages — that has to go to
testnet before anything else. Checkpoints cost gas (~10–20 transactions a game, from the treasury; that is
what the gas subsidy is for). And a choice inside it: the liveness window. 14 days is kinder to players
whose operator disappeared; 30 is kinder to an operator who had a bad week.

**Recommendation.** Option 2, 14-day window. Without it, none of Part A matters.

### A4. When does a finished game pay out?

**The question.** The plan had a mandatory 48-hour challenge window after every game. The audit noticed every
client already computes the final result and (with A2's session key) can sign it silently.

**Options.**

1. **Always wait the window.** Every game waits two days for money nobody disputes.
2. **Consent fast path.** Each client auto-signs (final appraisal, log hash). All signatures present → pay
   out now. A missing or disagreeing signature → the window opens for that game only.

**Consequence of (2).** A client that has silently drifted from the server would sign a *wrong* board or
refuse to sign a right one. So this is safe only after the divergence alarm has stayed quiet across several
full free games — which is Phase 2's exit test anyway. Requires A2.

**Recommendation.** Option 2, switched on only after that test passes.

### A5. What does a dispute cost, and who resolves it?

**The question.** A player says "the settlement is wrong." The chain cannot check. If disputing is free it is
a veto for whoever lost.

**Options — cost.**

1. **Free challenge.** Every losing player challenges every game.
2. **Bonded challenge.** Challenger posts a bond (at least their ante). Frivolous → bond goes to the pool.
   Upheld → bond returned and the settlement is replaced by the resolver's.

**Options — resolver.**

1. **You**, publicly, with the signed log as evidence. Simplest. Players are trusting you twice.
2. **A 2-of-3 key**: you plus two independent people who can post a corrected settlement. More credible,
   needs two people who will answer within the window.

**Also a parameter:** window length. 48 hours suits slow (async) games. For a live game where everyone
auto-signed there is no window; where one signature is missing, 24 hours is plenty.

**Recommendation.** Bonded, resolver = you for the first games, 24 h live / 48 h async. Say now whether you
want the 2-of-3 later, because the contract message shape depends on it.

### A6. Who is seated when the game deals — the room's list, or the chain's deposits?

**The question.** The deal seats whoever is in the waiting-room document. The plan's own rule says no game
rule may be decided from that document, and "who paid" is the most important rule there is: a seat that never
paid, or a payment that never got a seat, is otherwise possible.

**Options.**

1. **Free games seat from the room; money games seat exactly the addresses that deposited**, read from the
   chain, and the deal is refused if the two lists differ. Two code paths, one honest.
2. **Every game has a chain table, even free ones (zero ante).** One code path, but every free game needs a
   wallet and a transaction to start — which is most of the friction the kitchen-table mode avoids.
3. **Always from the room.** Money games can be mis-seated. Not an option with money.

**Recommendation.** Option 1. Depends on A2 (a player must *be* an address for the lists to be comparable).

### A7. What if everyone goes bankrupt?

**The question.** The payout function fails when total net worth is zero, and after A3 nobody can annul out
of it. Funds would be stuck.

**Options.** Equal split of the pool among players; or refund each ante. They differ only when antes were
unequal, which they are not today.

**Recommendation.** Equal split. Small; I will do it with A3 unless you object.

### A8. What happens to a player who disappears? (forfeit)

**The question.** The agreed design paid a forfeiting player their appraised share minus their ante. The
audit's arithmetic: if their lead is bigger than their ante, disconnecting is *profitable*, and they choose
the moment (right before their corporation is about to go bust).

**Options.**

1. **Keep the design.** Walking away while ahead pays.
2. **Forfeit pays zero.** Their share is split among the others by appraisal. **Clemency** (the others vote to
   forgive) returns at most their ante — never a profit. And the appraisal is taken at the **last completed
   round boundary**, not the moment they left, so they cannot pick a flattering instant. (Same snapshot the
   A3 checkpoint already posts.)

**Consequence of (2).** A hopeless player can still end the game for everyone out of spite. That is a
nuisance, not a way to make money; an "autopilot" mode (the game passes for them) is possible later and is
real work now.

**Recommendation.** Option 2, all three rules.

---

## Part B — about the game

### B1. Clocks — when, and how strict?

**The question.** No clock exists yet. Forfeit (A8) needs one. But the numbers (how long a turn, how much
reserve, what async means) should come from data, not guesses.

**Options.**

1. **Turn on a measuring clock in free games now** — visible, generous, no forfeit. Play three or four full
   games; set the real defaults from what people actually take.
2. **Design the full clock now** with guessed numbers, forfeit included.
3. **No clock until money.**

**Things the clock design will need from you eventually (not now):** whether the answerer of a trade offer is
on the clock (if yes, an opponent can drain your time by offering every turn — so offers need their own short
deadline with auto-decline); how long a mutual pause may last before it stops protecting the person who
asked for it; what a server outage does to the on-turn player's clock (it should be suspended, which needs a
heartbeat).

**Recommendation.** Option 1. It costs one afternoon and it is the only way to set numbers honestly.

### B2. Live and async — one mode or two?

**The question.** A 48-hour window, a 3-day turn allowance and a 14-day liveness window all assume async play.
A live evening at a table wants none of them.

**Options.** One mode with async numbers (live players wait for nothing they can see, but every timer is long);
or a room setting — Live / Async — that sets the clock, the window and the pause cap together.

**Recommendation.** Two modes, chosen when the room is created, fixed at the deal like the other variants.

### B3. The multi-train buy selector — fix it or delete it?

**The question.** Buying three trains at once charged for two, delivered two, and printed a line saying
three (triage §2.1). You also said most players just click Buy three times.

**Options.** Fix the selector (find why the count and the charge disagree); or delete it, since three single
purchases already go through the reducer correctly and there is nothing to keep in sync.

**Consequence of deleting.** Three clicks instead of one, and one fewer thing that can lie. Subtractions do not
come back.

**Recommendation.** Delete. Say so and it is a small change.

### B4. Retire the Firestore path?

**The question.** The server is now the only transport anyone uses, and Firestore has been unreachable for
weeks. But every new piece still gets a Firestore fallback (the accepted-offer purchase has one; the auto-skip
has one; the log allocation code is still there). Each fallback is untested code on a path nobody runs.

**Options.**

1. **Keep both** until the server is proven in N full games. Safe-sounding; in practice the fallback rots.
2. **Retire Firestore for rooms now.** The client requires a server URL; the Firestore append, subscribe,
   room-doc and index-allocation code comes out; the Firestore-only effects go with it. Chat stays on
   Firestore for now (it is not evidence). Solo sandbox (no room) is unaffected.

**Consequence of (2).** If the server is down, nobody plays — which is already true. Several hundred lines of
`App.tsx` and two utility files disappear, and the "one rule implemented twice" surface shrinks again.

**Recommendation.** Option 2, after the next playtest confirms the server path across the flows marked
"untested" in the triage doc.

### B5. Should clients keep running the rules after the server is authoritative?

**The question.** Every client replays the log and compares its board to the server's. That is the
divergence alarm. It could be switched off once the server is trusted.

**Recommendation.** Keep it. It is free, it has caught four real bugs, and A4 depends on clients computing the
final state anyway. No action needed unless you disagree.

---

## Part C — small, but yours

- **C1. Every player can export the log** (today: host only, Ctrl+Shift+L). Under settlement the log is the
  evidence, so everyone needs their own copy. I will just do this unless you say otherwise.
- **C2. Two-player edge cases in votes.** "Majority of the others" and "all of the others" are both *the one
  other player*, and the offender never votes. Stating it is enough; confirm.
- **C3. One person in two seats** cannot be prevented on-chain. A line in the rules, not engineering.
- **C4. Terms.** Bonded challenge, forfeit, operator-resolved dispute are things players agree to. They need a
  page before the first deposit, and you are the author.

---

## If you only answer four things

A2 (session key), A3 (no exit after the deal, 14-day window), A8 (forfeit pays zero), B4 (retire Firestore).
Everything else has a sane default or waits on data.
