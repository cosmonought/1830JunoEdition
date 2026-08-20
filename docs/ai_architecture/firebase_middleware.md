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

---

# `utils/sandboxRoom.ts` — The room log itself

### sandboxRoom.ts #0 — Why event sourcing is the only honest option here
The obvious design is to mirror the sandbox **game state** into a document and let `onSnapshot` push it
around. That cannot work in this codebase, and the reason is the reason for everything else.

**The sandbox is not one state object. It is three atoms plus a turn cursor:**

| Atom | Advanced by |
|---|---|
| `sandboxState` — the `GameStateResponse` | `applySandboxAction` |
| `mapGrid` — the tile grid | `applySandboxLayTile` |
| `sandboxMarket` — the price chart | `applySandboxMarketAction` |
| App-local | `orSubPhase`, route drafts, pending offers, and more |

They advance **together** on one dispatch, and each reducer takes a context built from the others.
Mirroring one atom would desync the other two; mirroring all of them means serialising a graph whose
shape is an implementation detail of four modules, **and any field added anywhere would silently stop
replicating.**

**The action log is already complete**, which is what makes the alternative work. Every sandbox mutation
goes through `runGameplayAction` as a `GameplayExecuteMsg` — including the tile lay, which dispatches
`LayTile` alongside its local `setMapGrid` — so the board is reconstructible from the same stream.
Replaying the log through the existing pipeline reproduces all three atoms **by running the code that
produced them, rather than by copying their output.**

That is also what gives refresh-resilience for free: a browser with no state reads the log from index 0
and arrives where everyone else is.

### sandboxRoom.ts #1 — The index is the contract
Order is everything — **1830 is not commutative**, and "buy share then pay dividend" is a different game
from the reverse. Each entry carries a monotonic integer `index` and readers sort by it.

**An integer, not `serverTimestamp()`.** `ChatBox.tsx #2` already recorded why in this codebase:
`serverTimestamp()` resolves to `null` in the local snapshot the SDK emits optimistically, so an entry is
briefly unsortable by the very field meant to sort it. **Chat can tolerate a message that jumps a place on
write. A game state machine cannot:** applying two actions in the wrong order produces a divergent board
that never reconciles, because every later action is computed against it.

`createdAt` rides along for debugging and for human-readable ordering in the Firebase console. **Nothing
reads it for sequencing.**

### sandboxRoom.ts #2 — The collision this does not solve
Two clients writing index N simultaneously is possible. Firestore's `addDoc` gives each a distinct
document, so both survive with the same index — and the tie-break (document id) is deterministic, so
**every client resolves it identically. Nobody diverges.**

What it does **not** do is prevent the second action from being computed against a state that did not
include the first. **That is a genuine limitation of a client-authoritative log with no referee, and it is
stated here rather than hidden:** the sandbox has no server to arbitrate, and building one is a backend
change. In practice 1830 is strictly turn-based and two players acting in the same instant are already
playing wrongly.

### sandboxRoom.ts #519 — A new top-level collection, beside `games`
A sandbox room has no chain game, no contract address and no on-chain roster — it shares none of
`RoomDoc`'s shape, and `firestore.rules` guards that collection with rules (write-once `chainGameId`, no
game-state fields) written for a document this one is not.

### sandboxRoom.ts #520 — The room code is read aloud
The code's whole job is to survive being **spoken over a voice call and typed by somebody else**, so the
alphabet is chosen for that rather than for entropy per character.

`0/O`, `1/I/L` and `5/S` are **out** — the pairs that get misheard and mistyped. **A room code that fails
one time in twenty is worse than a slightly longer one that never does.** What remains is 22 letters and 7
digits; three characters is ~24,000 combinations, ample where rooms are abandoned within an hour and a
collision merely means picking again.

**The first draft of this table kept `0`.** It dropped `O` from the letters and `1`/`5` from the digits and
then ended `…67890` — so the one character most likely to be confused with a letter survived the rule
written to remove it. The harness caught it on the second run; a reviewer reading the string would have had
to count. **That is the argument for asserting the property (no confusable character appears) rather than
pinning the alphabet, which would merely have recorded the mistake.**

**The `JUNO-` prefix is part of the code, not decoration.** It makes the string self-describing when it
turns up pasted in a chat window with no context, and it gives `parseRoomCode` something to recognise.

**Forgiving on input, strict on output:** lower case, missing prefix, surrounding spaces and a pasted
`juno-4t2` all resolve to `JUNO-4T2`; anything that is not a real code resolves to `null` rather than to a
plausible-looking room nobody is in. **A player mistyping a code should be told, not silently dropped into
an empty room they will wait in.**

### sandboxRoom.ts (message encoding) — JSON text, not a nested map
Firestore **rejects nested arrays**, and several messages carry one (`RunManualRoute.path` is an array of
objects). Round-tripping through JSON also guarantees every client applies a structurally identical object
rather than one Firestore has reshaped on the way through.

### sandboxRoom.ts #643 — When it happened, not when it was replayed
**Reported:** the activity log stamps every entry in a game with the same time, and re-reports actions from
earlier playthroughs.

`appendSandboxAction` has always written a `createdAt` server timestamp; **`toAction` simply never read it
back.** So a client rebuilding from the log had no idea when anything happened and stamped each replayed
entry with `Date.now()` — which, during a rebuild, is the same instant for the whole game. **Every timestamp
identical is not a clock bug; it is an accurate record of when the replay ran.**

`undefined` for entries written before this, and for the moment between a local write and the server's
timestamp resolving. Callers fall back to the current time.

### sandboxRoom.ts (append) — `nextIndex` is the caller's, which is why this is not a transaction
The caller already holds the live log (it is subscribed to it), so it knows the next index without a round
trip. **A `runTransaction` that re-read the collection on every dispatch would add a network round trip to
every click for a guarantee `#2` explains this cannot make anyway.**

### sandboxRoom.ts (subscribe) — The whole ordered log, not a delta
The consumer's job is "make my state match this sequence". A delta would make it "apply exactly the entries
I have not seen" — **the same thing when nothing goes wrong and a silent desync when anything does** (a
dropped snapshot, a reconnect, a late entry landing behind the cursor). The caller tracks how far it has
applied and takes the tail; **that cursor is cheap to keep and impossible to get subtly wrong.**

### sandboxRoom.ts #527 — The room document is the anteroom, not the game
`#0` argues at length that game **state** must not be mirrored into Firestore. The waiting room is the one
thing that is legitimately document state, and the distinction is worth being precise about **because it
looks like an exception.**

**What lives in the document is everything true BEFORE the game exists:** who is here, what they are
called, whether they have said they are ready. None of it is derived from anything, none of it is ordered,
and **a late write simply wins** — exactly the shape `onSnapshot` on a document handles well and an
append-only log handles badly (a "ready" that toggles twice would otherwise be two entries the replay has
to reconcile).

**The moment the game starts, that stops being true.** `status: "playing"` is a latch, and everything after
it comes from the log. **The document owns the lobby, the log owns the game, and `status` is the handover.**

### sandboxRoom.ts (join) — A transaction, unlike the append
The players array is a **read-modify-write on one field that several clients touch at once**, so a plain
update would drop whoever wrote a millisecond earlier — the classic lost join. The action log needs no
transaction because appends never touch the same document; **this does because they all touch this one.**

### sandboxRoom.ts #541 — Editing a name is not rejoining
**Reported:** clicking "Set Name" twice appears to reorder the players.

It did exactly that. The update filtered the player out and appended them: `[...others, player]`. **So every
nickname edit and every ready toggle moved that player to the back of the array**, and two people editing in
turn churned the whole roster.

**The order is not cosmetic.** `toSetupPlayers` reads this array to build the payload the host shuffles, so
a lobby whose list reshuffles itself while people are typing is a lobby whose seating nobody can predict —
**and it moves under the reader while they are looking at it.**

An existing player is **updated in place** and only a genuinely new one is appended.

### sandboxRoom.ts (ready check) — Both conditions
Every player marked ready, **and enough of them to deal a legal game.** The second is the one a ready check
usually forgets: one person alone in a room can tick ready and satisfy "all ready" trivially. 1830 needs at
least two.

### sandboxRoom.ts #528 — Who this browser is
The waiting room needs to tell one player from another, and the sandbox has no wallet and no
authentication. Each browser mints an id once and keeps it in `sessionStorage`.

**Session, not local, storage.** Two tabs of the same browser must be **two players** — that is how a single
developer playtests this at all — and `localStorage` is shared across tabs, so both would claim the same
seat and the second join would overwrite the first. `sessionStorage` is per-tab, exactly the granularity
wanted.

**It survives a refresh**, which is the other half: a player who reloads mid-game must reclaim their own
seat rather than appear as a new one and find the game has more players than it dealt for.

---

# `config/firebase.ts` — Initialisation and configuration

### firebase.ts #0 — The architectural boundary this file sits on
**Firebase is Web2 and off-chain only.** It carries exactly three things:

1. **Chat** — `games/{gameId}/chat`
2. **Player presence** — `games/{gameId}/seats/{address}.lastSeen`
3. **Room discovery** — the `games/` collection, i.e. the pre-game staging lobby that exists *before* a room
   is on-chain at all

The Juno contract remains the **single** source of truth for game state, rules, board tiles, treasuries,
turn order and turn execution. Nothing in this module — or anything reading from it — may store, derive,
mirror or validate official game state. **Firestore is in Test Mode (open read/write); treating anything it
returns as authoritative would mean treating an anonymous, unauthenticated, client-writable document as
authoritative.**

**The one field that looks like it crosses the line and does not:** `RoomDoc.chainGameId`. That is a
**pointer**, not state — the `u64` the contract itself assigned at `CreateGameRoom` and emitted as a tx
attribute. It is written once by the host from a confirmed transaction result and thereafter only ever used
as the argument to a real `GetGameState` query. **If Firestore lies about it, the query returns a different
room or fails outright; it cannot make the contract agree.** `firestore.rules` enforces this in the database
itself — `chainGameId` is write-once, and no client may write any field named for game state.

### firebase.ts #1 — Why this file does not throw at import
Identical reasoning to `config.ts #0`, and the same failure it was written to prevent. That module used to
validate at module scope, which **crashed the whole bundle before React could mount** whenever `.env` was
incomplete, and made the documented Offline Sandbox Mode unreachable.

Firebase would reintroduce exactly that bug in a new place: `initializeApp` with a missing
`apiKey`/`projectId` **throws synchronously**, and at module scope it would take down the app at `import`
time — for a subsystem that only carries chat and lobby. **Losing the entire rail map because nobody
configured a chat backend is an absurd failure mode, so it is structurally prevented here rather than
merely avoided by convention.**

Two-tier rule:

- **Reading config never throws.** Unset values are `undefined`, meaning "no real-time backend" — a
  legitimate state in which the board, the tile catalog and every on-chain query still work perfectly.
- **Requiring a live Firestore handle throws**, and only at the moment an operation genuinely needs one.
  The error names the exact missing variable.

`getFirestoreDb()` returns `null` rather than throwing, and every caller degrades to a clearly-labelled
"real-time features unavailable" state.

### firebase.ts #2 — Lazy, idempotent initialization
Deferred to first use and memoised, for **three separate reasons that each independently require it**:

- `#1`: it must not run at import.
- **`React.StrictMode` double-invokes effects in development.** An effect that initializes Firebase would
  run twice, and `initializeApp` throws `app/duplicate-app` on a second call with the same name. The
  `getApps().length` check makes a second call reuse the existing instance.
- **Webpack HMR** re-executes a changed module while the previous Firebase app is still live in the same
  page — the same duplicate-app collision by a different route. Same guard covers it.

### firebase.ts #3 — Validation is shape-only, and only for what Firestore uses
Matching `config.ts #3`: this checks the **shape** of each value to catch "still a placeholder" and "left
unset", **not to verify the credentials are real.** A wrong-but-well-formed `projectId` is caught by
Firestore with a clear permission/not-found error; a placeholder was not, which is the whole reason for the
check. (`"your-project-id"` is a **well-formed** project id and deliberately passes; the check rejects the
dotted/underscored/uppercase placeholders people actually paste.)

**Only three variables are required**, because this app uses Firestore and nothing else:
`REACT_APP_FIREBASE_API_KEY`, `REACT_APP_FIREBASE_PROJECT_ID`, `REACT_APP_FIREBASE_APP_ID`.

`authDomain` (Auth), `storageBucket` (Storage) and `messagingSenderId` (FCM) are passed through when present
but are **not** required, because no code path touches those products. **Requiring them would fail the app
for a missing value it never reads** — the precise species of dishonest validation `config.ts` exists to
avoid. Revisit the moment Auth is added, which it should be before Test Mode lapses.

**Nothing secret goes here.** Every one of these values ships to the browser in plain text. **A Firebase
"API key" is a public project identifier, not a credential** — it identifies which project a request is for
and grants nothing on its own. What actually protects the data is `firestore.rules`, **which is why that
file matters far more than any value here.**

### firebase.ts (env reads) — Literal `process.env.REACT_APP_FOO` expressions only
`react-scripts` substitutes them **textually at build time**, and neither destructuring nor dynamic indexing
is substituted — **both silently yield `undefined` in a production bundle.** `readOptional` is shared from
`config.ts` and takes the already-read **value** for exactly that reason.

### firebase.ts (handles) — `null` is a supported state
`getFirestoreDb()` returns the handle or `null`; pass it straight through and render a "real-time offline"
affordance. **Do not coerce it or assert past it.** `isFirebaseConfigured` should **label the UI honestly,
not hide the failure** — a player who sees "Real-time offline" and a reason is informed; one who sees an
empty room list is misled into thinking nobody is playing.

The throwing variant is for a path **about to perform a real read or write** with a caller able to surface
the error — never at module scope, and never on a render path the unconfigured state also takes.

### firebase.ts (collection paths) — One definition, shared
Same rule as `config.ts #1`: **a path string duplicated across modules is a path string that will eventually
drift.** These three are the **entire** Firestore surface this app uses, and `firestore.rules` is written
against exactly these shapes — **change one here and the rules file must change with it, or writes start
being denied in production while continuing to work in Test Mode.**
