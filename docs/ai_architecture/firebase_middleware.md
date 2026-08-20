# Firebase Middleware — Event Sourcing, Rooms, Chat, Presence

The off-chain transport layer: the event-sourced room log, the replay drain, the setup event,
presence heartbeats, chat, and the strict boundary between Firestore and the Juno contract.

Anchors are `<source file> #<N>`. Search the number.

---

## The boundary

### App.tsx #22 — Firebase carries chat and presence ONLY
Restated in `App.tsx` because that is where it would be easiest to violate: **the Juno contract
remains the single source of truth** for game state, rules, board tiles, treasuries and turn
execution. Firestore stores none of it. Two transport-level changes only:

- `chatMessages` is no longer `useState<ChatMessage[]>` fed by a local `nextChatMessageId++`
  counter; it comes from `useFirestoreChat(roomId, ...)`.
- `usePresenceHeartbeat` runs for the whole session so the table can see when the active
  turn-holder has dropped. **A UI hint with no authority** — the contract's Inactivity Timeout
  Safety Valve is the only mechanism permitted to have consequences for an absent player.

`actionLog` remains entirely local and on-chain-derived. It is **not** written to Firestore —
mirroring it would be the first step toward treating an off-chain document as a game log.

### App.tsx #1 — `gameId` and `roomId` are never interchangeable
`gameId` is the **contract's** `u64`, assigned at `CreateGameRoom` and parsed from that
transaction's own `game_id` attribute (`Lobby.tsx #2`). `roomId` is the **Firestore** room id.
`gameId` addresses the contract; `roomId` addresses off-chain chat and presence. Both are
load-bearing.

`components/Lobby.tsx` is the room-selection screen and `GameRouter` is the boundary: with no room
chosen it renders the Lobby; once a player is genuinely in a room's on-chain roster it renders
`AppShell` with a real `gameId`.

### App.tsx #548 — The stored room pointer holds both ids
Survives a reload so a player who refreshes mid-game lands back at the board rather than the room
list. Holds **both** ids because they address two different systems and neither can be derived from
the other.

---

## The event-sourcing loop

### App.tsx #522 — In a room, the log is the only way in
A local click in a room **does not touch state at all**. It appends to Firestore and stops. The
`onSnapshot` listener then replays it back through the same `runGameplayAction` with
`isRemoteReplay`, which is what actually moves the board.

**So the local player takes the same route as everyone else.** That costs a round trip before your
own action appears, and it buys the property that makes the design work: there is exactly one order
of operations, the one in the log, and every client — including the one that acted — derives its
state from it. An optimistic local apply would give the actor a state nobody else has, and
reconciling it would mean rewinding and replaying on every remote action.

`appliedIndexRef` is the cursor and the append reads it for the next index. A **ref**, not state,
because `runGameplayAction` sits in the dependency array of the auto-skip and forced-withhold
effects (`#439`) and rebuilding it re-arms effects that **dispatch**.

### App.tsx #522 (cursor) — Four pieces of state, three of them refs
Same reason throughout: `runGameplayAction` reads them, and that callback is in the dependency
array of the two effects that dispatch on the player's behalf. Rebuilding it on every applied action
would re-arm those effects mid-replay — a render becoming a transaction, and during a replay a
transaction becoming a second log entry.

### App.tsx #591b — Two counters, because they count different things
One number used to serve both jobs, and **undo** is what separates them. The log is append-only so
"how long is the log" only grows; the list of actions that still **count** shrinks the moment
somebody reverts.

- `appliedIndexRef` — "where does the next append go": the log's length, so an undone action still
  occupies its index and nothing is written over it.
- `appliedCountRef` — "how much of the live history have I run": a position in the effective list,
  which the drain compares against to notice a rewind.

Conflating them would make an undo look like a gap in the log.

### App.tsx #523 — The listener is the only writer
Everything that changes sandbox state in a room arrives here first, in log order, and is replayed
**through `runGameplayAction`** — not a stylistic preference: `applySandboxAction` takes a context
assembled in that function from `mapGrid`, the market and the era. Calling the reducer directly
would replay every action against a context this file would have to rebuild by hand, and the first
forgotten field would be a silent divergence rather than a crash.

**The tail, not the delta.** `subscribeSandboxLog` hands back the whole ordered log every time, and
this takes everything past `appliedIndexRef`. A snapshot arriving twice, out of order, or after a
reconnect therefore cannot double-apply or skip — the cursor decides what is new, not the event.

**Sequential and awaited**: the sandbox reducer is synchronous through refs, so firing the tail in
parallel would let action N+1 read the state before N wrote it. `replayingRef` additionally stops a
second snapshot interleaving with a replay in flight.

`automatic: true` keeps replayed actions off the Undo stack (`#475`).

`#527`: the **room document** owns the lobby and is a separate subscription from the log, which
owns the game — two systems with one handover (`status`).

### App.tsx #591b (rewind) — A shorter history means start again
The log never shrinks; the list of actions that still count does. That is the one thing an
incremental cursor cannot follow: it knows how far it has read, not whether what it read is still
true. So the drain asks `effectiveActions` for the live history and compares its **length** against
how many actions it has applied. Fewer means an undo landed — throw the state away and replay from
the fixture. More means ordinary play.

**A full replay is the cheap option**, worth stating because it looks expensive: a few hundred
reducer calls over a plain object is milliseconds, and it reaches exactly the state the log
describes. Inverting each message would need one correct inverse per message type, and the ones
touching the market, the era or a waterfall cascade would be wrong in ways no test would obviously
catch.

### App.tsx #454 (shadowing) — Named `history`, not `live`
The first version called this `live` and shadowed the effect's own `let live = true` cleanup flag,
so `if (!live) return` inside the loop tested a non-empty array instead of whether the subscription
had been torn down. A replay would have gone on writing state after unmount. ESLint caught the
now-unused outer binding; the shadow itself would have been silent.

### App.tsx #643 — The log is rebuilt too, not appended to
**Reported:** the activity log holds events from previous playthroughs and reports each game's
actions more than once.

A rewind throws game state away and replays from zero — and the replay writes a log entry per
action, as any dispatch does. Entries from **before** the rewind were still in `actionLog`, so every
undo doubled the history, and the doubled copy included actions the undo had declared never
happened. The log is a **rendering** of the action list, so it is rebuilt from the same source at
the same moment as the state it describes.

### App.tsx #465 — Read once before subscribing, to tell the player the room exists
An empty log is otherwise indistinguishable from a wrong code, and the subscription would happily
listen to a room nobody is in. The replay itself is left to the listener; doing it here would apply
the history twice.

### App.tsx #551 — Leaving forgets the room
Written directly rather than routed up through the router's state: the shell owns the leaving, and
a prop drilled two levels for one string would be a longer path with the same effect. Seeding from
the session means a refresh comes back into the room.

---

## Setup: dealing the table

### App.tsx #529 / App.tsx #533 — No board until there is a game
The gate **returns early** rather than conditionally rendering the board underneath. Before the
setup event lands the player count is undecided, so starting cash and the certificate limit are
undecided — and those are what the ledger, the stock cards and the certificate counter render from.
A board shown here would be a plausible, correctly-drawn game that nobody is playing.

`status === "waiting"` is the only test. It is a latch the host flips once (`#532`) and it flips
only **after** the setup entry is in the log — so by the time any client leaves this screen, the
action that deals the table is there to be replayed.

### App.tsx #532 — The host deals, once
Two writes, and the order is the whole safety property:

1. **Append** the setup event to the log.
2. **Latch** the room document to `status: "playing"`.

The log first, because the status flag is what every client uses to leave the waiting room —
flipping it before the setup entry exists would send them all to a board whose state has not been
dealt. Doing it afterwards means the worst case is a client sitting in the anteroom a moment
longer, which resolves on the next snapshot.

The shuffle happens **on the host, once** (`#526b`), and `toSetupPlayers` reads the roster from the
room document rather than anything local, so the table dealt is the table the waiting room showed.

### App.tsx #531 — Setup builds the table, then gets out of the way
The setup event is handled **first** and returns, because it is not a move in a game — it is what
makes the game exist. Nothing below it applies: there is no market move to project, no corporation
to charge, and `applySandboxAction` would be handed a message it has never heard of.

**Idempotent by position, not by a guard.** The log holds exactly one setup entry because only the
host may write one (`#529a`), and every client applies it at the same index — so a replay from zero
rebuilds the same table rather than dealing a second one over the first.

`dealSandboxGame` returning `null` is a roster 1830 cannot deal. The state is left **alone** rather
than half-applied: a board dealt for a count that does not exist is worse than one that visibly
never started.

### App.tsx #531a — The setup event never leaves the sandbox
`SetupGame` is not a `GameplayExecuteMsg` and must not become one — `sessionKey.ts` maintains that
type as the authz allow-list, and a variant the chain has never heard of appearing in it would be a
lie about what the wallet may sign (`#530`).

### App.tsx #539 — This guard used to `return` here, and that was the bug
The first version read `if (isSetupGameMsg(msg)) return;` with a comment asserting "the sandbox
branch above handles it and returns, so this line is unreachable". **The sandbox branch is below** —
some forty lines further down — so this guard ran first and every `SetupGame` returned here, on
every client, every time. The setup action reached the log, replayed correctly, entered the
function, and was discarded one step before the handler that deals the game.

That is why the roster was empty and why nobody could act: with `player_addresses` still `[]`, no
seat matches anyone, so `isMyTurn` is false for all and the turn gate refuses every action. **Two
symptoms, one dropped message.**

The comment is the lesson: it stated an ordering confidently and the ordering was wrong — a claim
about control flow that would have taken one `grep -n` to check. It **narrows** rather than
returning now: `chainMsg` is `null` for a setup event, the sandbox branch gets its chance, and the
refusal happens at the chain dispatch, the only place that actually must not see one.

`#546`: the predicate is `isSandboxOnlyMsg`, not `isSetupGameMsg` — there are now two events the
contract has never heard of, and one predicate for both means adding a third cannot leave this line
behind.

### App.tsx #537 — A room's state comes from the log, not a fixture
**Reported:** a multiplayer game boots and still shows the four offline mock players.

The re-seed effect fires on `sandboxScenarioId` and `sandboxTrainFixture` — the debug toolbar's
controls. In solo sandbox that is right. In a room it is destructive: state there is derived by
replaying the log, and re-seeding substitutes a fixture, so the roster reverts to four mocks and
every client that touched a toolbar control plays a different game. **The seeding stops at the room
boundary.**

### App.tsx #538 — One seeding rule, three readers
The state, its synchronous ref and the scenario re-seed effect all derive their board from one
place. They seeded independently before, which is how two ended up with the fixture's roster while
the third had been corrected. **In a room the roster is empty**: the board loads, the players do
not, and `SetupGame` is the only thing that ever adds one.

### App.tsx #537a — Setup must not be skippable
This read `sandboxStateRef.current` and **returned** if it was null. That ref is synced by an
effect and the replay drain is async, so on a fresh join the setup event could arrive before the
ref had been written, and the one action that deals the game would be silently dropped. The board
would keep the fixture's four mock players for the rest of the session with nothing to say why.

A silent early return on a timing condition is the worst available failure: the log is intact, every
later action applies, and the game is simply wrong. The base now falls back through the ref, the
rendered state, and finally a freshly computed fixture — the last of which always exists.

### App.tsx #542 — The auction atom is roster-bearing too
A room's copy must never carry the fixture's bidders. Seeded empty, then filled by `SetupGame` —
the same shape `sandboxState` follows. Dealt in the **same handler** from the same roster: two
atoms advancing on one action is this file's established pattern, and splitting them is how the
Action Bar and the auction panel came to disagree about who is playing.

Read **from the ref, with no fallback** — a fallback would have to recompute the fixture, pulling
`sandboxPhase`, `gameId` and `sandboxIsZeroState` into the callback's dependencies and re-arming the
two effects that dispatch (`#439`).

### App.tsx #535a — The fixture's owners go with its players
Replacing `player_addresses` alone is not enough. The sandbox fixture is a **mid-game** testbed: its
corporations already have presidents and its privates already have owners, and every one is a mock
address. Swap the roster and leave those alone, and the board is presided over by people who are not
in the game — corporations nobody in the room can act for, because every `canAct` compares a
president against the viewer.

**So a room starts unowned**, which is also what 1830 says: every certificate begins in the IPO and
every corporation is unfloated until somebody buys in. The **board** survives — corporations,
privates, the map and the market are what a room plays with. Only ownership links to players who no
longer exist are cut.

### App.tsx #535 — The room's own names
**Reported:** a live game still shows the offline mock players.

`sandboxPlayerLabel` resolved a name by looking the address up in `SANDBOX_PLAYERS` and indexing
`["Alice", "Bob", …]`. A real player's id is a minted `p-xxxx` not in that array, so it returned
`null` and every caller fell through to `truncateAddress` — the game was not showing Alice
*instead of* the real name, it was showing a truncated id because it had no name to show.

`nicknamesRef` carries the room's roster, written when the setup event lands. The wrapper keeps the
**original function name**, so roughly a dozen call sites resolve correctly without being touched —
renaming them all would have been a much larger diff for the same behaviour, and the diff that
misses one. **The fixture table is the fallback**, not the other way round.

### App.tsx #522a — The tile grid is its own atom
No reducer in `sandboxSession` touches it, so the one message that changes it applies it in the
dispatch path, on the single path both a local click and a replayed action take. Derived entirely
from the message's own parameters, which is what makes it reproducible from the log.

The board write used to happen beside the dispatch in `handleTileDispatched`, and moving it inside
is what makes a tile lay replicate at all: a remote client never runs that function — it receives
`LayTile` from the log and replays it through the dispatch. With `setMapGrid` outside, that replay
charged the treasury and left the board blank.

### App.tsx #549 / #549a — The actor field held a label
`actor` used to be written from the player's **nickname**. A nickname is not an identity: two people
may pick the same one, anybody may change theirs mid-game, and nothing in `player_addresses` will
ever equal one — so the field could not be used to attribute an action even in principle.

It is now **the seat the action acts for**, not the browser that sent it. For an ordinary click
those are the same (the turn gate has already refused anything else). For an `automatic` dispatch
they are not: the game is acting on a rule on behalf of whoever is on turn, and crediting that to
whichever client's effect fired first would attribute a withhold to a spectator.

`#549` (drain half): set only by the replay drain from the log entry's own author — a local dispatch
leaves it undefined and the reducer falls back to the turn cursor, which for a local dispatch is the
same seat by construction.

### App.tsx #550 — A choice is logged, a consequence need not be
### App.tsx #576 / App.tsx #576a — A consequence is not appended, it is derived
**Reported:** the Camden & Amboy issued **twice** the share it should have, and the certificate
count jumped accordingly.

The previous pass appended an `ExchangePrivate` event from inside the **replay** of the winning
action — which runs on every client. Every client appended its own copy, the log grew two grants for
one win, and every client replayed both.

The test was already written down and applied backwards. The B&O's par is a **choice** and is
logged; the C&A's share is a pure **consequence** of a win already in the log, so every client can
derive it from the same action at the same moment without anybody announcing it. Derived and applied
to the resolved state directly — no append, no second event, nothing that can double because two
browsers both noticed the same thing.

### App.tsx #662 — The offer arrives on the owner's screen
**Reported:** "P1 sent an offer to buy P2's Private Company, but the decision modal appeared on P1's
screen and allowed them to accept it."

The proposal was React state in `App.tsx`, resting on `#205`'s premise: the local stand-in exists
"for exactly ONE deployment: the offline sandbox, which has no chain to record an offer in and no
second client to show it to." That premise expired when `#578` removed solo mode.

Handled **in the drain**, beside `ExchangePrivate` and for the same reason: the drain is the path
every client runs, so writing the offer there is what makes the seller see it. The answer then clears
it on both screens rather than on whichever one clicked — the same correction `#565` made for the
B&O par prompt.

An answer to an offer that is not on the board is **not an error worth stopping a replay for**: two
clients can answer the same offer before either sees the other. The first answer settles it and the
second finds nothing to settle.

Accepted offers go through the ordinary `BuyPrivateCompany` message, so consent and legality are
checked by the same code every other purchase uses (and `#660`'s B&O ban applies).

### App.tsx #565 — Derive the question, do not latch it
**Reported:** refreshing during the Stock Round brings back the modal asking the B&O's winner to set
a par value — a decision made rounds ago.

A refresh replays the room's whole log from index zero (`#551`, and that is what makes a rejoin work
at all). So the auction's winning action runs again and `setBoParPrompt` fires again. The `SetBoPar`
event that answered it is further down the log and now closes the prompt when it replays — but that
only holds while the two arrive in that order, and it would still flash the modal on the way past.

**So the modal asks the board, not a flag.** "Does the B&O still owe a price" is a question
`public_companies` can answer at any moment, and an answer derived from state cannot be stale, cannot
be raised twice, and cannot survive the thing that resolved it. `pendingHomeTokens` (`#416`) is the
same shape.

**The latch stays**, because it carries something the board does not: **who won**. A par set by the
wrong player would be worse than a modal shown twice. The latch says who may answer; the derivation
says whether there is still anything to answer.

---

## Chat and presence

### App.tsx #22 (chat state) — One hoist, one call site
`chatMessages` moved up from `Chatbox.tsx` so it could be merged with `actionLog` into one
chronologically sorted timeline. Note what did **not** have to change when the transport was swapped
for Firestore: `feedItems`, the filter, the unread count, `TopTicker` and `InlineQuickChat` — every
one was already reading from `mergeFeedItems` rather than owning chat state. That is the payoff of
the hoist `#18` performed.

Keyed on `roomId` (Firestore), **not** `gameId` (contract) — chat is off-chain and belongs to the
off-chain room, which lets the staging-room transcript in `Lobby.tsx` continue uninterrupted into
the live game instead of resetting at launch.

Chat message ids are now Firestore document ids — globally unique and identical in every player's
browser, which a per-client counter could never be. `ChatMessage.id` was widened to
`string | number` rather than hashing the id back down to a number.

`truncateChatAddress` and the `ChatMessage` type are no longer imported into `App.tsx`: both were
only used to **construct** chat messages locally, and this file no longer constructs any.

Sending pushes to `games/{roomId}/chat`. The draft is cleared optimistically because the write is
**also** optimistic — Firestore applies it to the local snapshot before the server confirms.

The display name is read **once at mount** rather than subscribed to: the name is set in the Lobby
before this component exists, and a rename mid-game would correctly not rewrite the byline on
messages already sent — `ChatBox.tsx` denormalises the name onto each message for that reason.

### App.tsx #644 — The sandbox gets its own room and its own identity
This read `sandbox ? null : roomId`, which switched chat off entirely in the mode most people are
playing. **The identity matters as much as the room**: `wallet.address` is null in a sandbox and
`sendMessage` refuses without an author, so passing the room alone would have moved the refusal
rather than removed it. `localId` is the sandbox's own stable id — the same one the action log
records as `actor`, so a message and a move made by the same seat agree about who did them.

`sandboxRoomCode` is null until a room is opened, and that is the local case rather than an error:
the hook keeps those messages in memory. A solo sandbox has a working chat box with nobody else in
it, which is the honest rendering of a solo sandbox.

*(Prior reasoning, `#24`: `SANDBOX_ROOM_ID` names no real Firestore document, and subscribing to it
would **create** one the first time anyone typed, littering the room collection with junk rooms.)*

### App.tsx #22 (presence) — Heartbeat suppression
Suppressed for **spectators** (`#23`): a spectator holds no seat document, so a heartbeat would be
an `updateDoc` against a path that does not exist — a guaranteed rejected write every 20 seconds.
Passing `null` disables the hook outright rather than relying on its fire-and-forget `catch`, which
would work but would be failing on purpose. Sandbox has no Firestore room either (`#24`).

### App.tsx #524 — The room is chosen before the board exists
`#522` mounted the room strip inside the shell, which put "host or join" behind "enter the sandbox"
— so two playtesters had to agree to open the board separately, find the strip, and only then
discover each other. The decision belongs where the other lobby decisions are.

The Lobby hosts or joins and hands the code through `GameRouter` as the **starting** value; the
shell still owns the listener, the cursor and the dispatch intercept. Seeded as `useState`'s initial
value rather than by an effect, so the listener's first run already has the room — an effect would
open a solo session for one render and then swap it, replaying the log into a board that had already
begun.

### App.tsx #551 (shell remount) — Remount cleanly on a room change
Without the key, switching rooms would keep the previous room's `actionLog`, ticker scroll position
and OR sub-phase cursor — state that is meaningless in a different game and actively misleading in
it. `mode` is part of the key too (`#24`): a viewer who spectates a game and then joins it properly
must get a genuinely fresh shell.
