# Session Keys, Wallet & Viewer Identity

The `x/authz` session key layer, the query client, spectator/read-only mode, and who the dashboard
thinks it is looking at.

Anchors are `<source file> #<N>`. Search the number.

---

## Dispatch pipeline

### App.tsx #4 — One pipeline, whatever the parameters
Every gameplay button calls the same `execGameplay` → `execViaSessionKey` → `authz.MsgExec` pipeline
`PassTurn` does. During the wiring milestone, buttons with no picker UI yet used hardcoded
constants labelled "(mock)" in their own button text — but clicking any of them was how the screen
visually proved the background pipeline fires, via the Action Log.

### App.tsx #7 — One shared live `GetGameState` poll
`utils/gameState.ts`'s `useGameStatePolling` is a typed, interval-driven (default 6s) poll of the full
`GameStateResponse`. The balance display, the turn-alert comparison, the Contextual Sub-Panel, the
action bar's round-type switch, the ledger tab, and `HexGridRenderer`'s `currentEra` prop **all derive
from this one shared result**. Every action that mutates game state calls the poll's own
`refreshGameState()` afterward.

### App.tsx #26 — `gameId` belongs in every dependency array
The contract's `u64`, assigned by `CreateGameRoom`. It did **not** used to be in the dependency array
of the gameplay `useCallback`s, and that was correct then and would be a bug now: `MOCK_GAME_ID` was a
module-scope constant, so a closure over it could never go stale, whereas a **prop** can.

`GameRouter` additionally keys `AppShell` on it, so in practice the component remounts rather than
re-closing — but **a correct dependency array should not be load-bearing on a `key` prop two files
away.**

### App.tsx #530 — The allow-list must not lie
`sessionKey.ts` maintains `GameplayExecuteMsg` as the authz allow-list. A variant the chain has never
heard of appearing in it would be a lie about what the wallet may sign. See
`firebase_middleware.md` `#531a` / `#539` / `#546` for how sandbox-only events are kept out of it.

---

## Read-only / spectator mode

### App.tsx #23 — Read-only is enforced at the dispatch sites
**Hiding a control is a courtesy to the user; refusing to dispatch is the guarantee**, and only the
second survives a future pass adding a button without knowing spectators exist.

The app has exactly **two** paths that can execute a gameplay message, and read-only mode is only as
good as its coverage of both:

1. **`runGameplayAction`** — the funnel for every button on the Contextual Action Bar, the Waterfall
   dashboard and the train-trade panel. Gated inside the function itself, so all ~20 controls are
   covered by one check. Disabling buttons individually would be a list that has to be kept complete
   forever; this is one invariant a new button cannot opt out of.
2. **`TileSelectionPopup`** — calls `useGameSession().execGameplay` **directly** (`#1` there), so the
   gate in (1) does not apply. Covered by **not mounting it** when `spectator`.

**If a third dispatch path is ever added it must be gated too.** `grep -rn 'execGameplay('` over
`src/` is the check, and it should return exactly those two call sites.

**Belt and braces regardless:** a spectator is not in the contract's `player_addresses`, so the chain
would reject anything they sent. These gates make that refusal instant, free and legible rather than
costing a signature to discover.

Refusals are **logged rather than silently dropped**, so a spectator who finds a control this pass
failed to hide gets an explanation instead of a dead click.

### App.tsx #23 (query client) — A spectator has no wallet requirement
There may be no `signingClient` to query through, and every live panel reads through one.
`useGameStatePolling` takes a structural `QueryCapableClient` (just `queryContractSmart`), which a
plain `CosmWasmClient` satisfies without any signer, key or Keplr prompt.

So: use the wallet's client when there is one, and otherwise connect an anonymous read-only client.
This also quietly improves the **player** path — the board now renders before the wallet is connected
instead of sitting empty until it is.

`undefined` in sandbox, which stops every poll at source (`useGameStatePolling` treats a missing
client as offline and never queries). Panels render their own empty states, which is the honest
depiction of a board with no chain behind it.

### App.tsx #199 (spectators) — A control they can open and never use is noise
Spectators are excluded from the tile selector's arming condition as well as by `runGameplayAction`'s
gate, for the same reason the action bar is hidden from them. *(Later split by `#437` — see
`canvas_rendering.md`: **inspecting** is open to everyone, **acting** keeps every restriction.)*

---

## The sandbox has no session key

### App.tsx #220 — The sandbox has no session key, and never will
**Reported:** "the Buy Station Token button does not do anything — it does not change the cursor, nor
does it allow placement."

The button was fine. So was the cursor and the click path. Every control in the Contextual Action Bar
renders `disabled={btn.disabled || !sessionReady}`, and `sessionReady` was
`session.sessionStatus === "ready"` — true only after a player initialises an `x/authz` session key
against a connected wallet.

**The sandbox has no wallet by construction** (`#24`: the question is not "may this viewer act?" but
"is there a chain at all?"). `sessionStatus` therefore sits at `"uninitialized"` forever and every
button in the bar was permanently disabled — **not visibly so**, either: `actionBarButton` carries no
disabled styling of its own, because inline styles cannot express `:disabled` (`Lobby.tsx #3`), so the
controls looked completely normal and silently swallowed every click.

That explains a whole family of "this button does nothing" reports at once, and it is why the same
complaint kept coming back after the handlers behind those buttons were fixed: **the handlers were
never reached.**

The gate is right for a **live** room — dispatching without a session key would fail at signing time.
It is simply the wrong question in the sandbox, where `runGameplayAction` short-circuits into the
local reducer and never signs, broadcasts or touches a wallet. One derived value now asks the honest
question — **"can this build dispatch anything?"** — and every panel reads it, so the two cannot drift
apart the way `TrainPurchasePanel` already had to work around locally.

### App.tsx #24 — The escape hatch needs no wallet, no contract, no Firestore room
Which is the entire point, since the absence of all three is what made the lobby inescapable.

The sandbox branch of `runGameplayAction` applies the action to the **local reducer** instead of
signing anything. Nothing is broadcast and no wallet is touched — the message never leaves the
function — but the mock state advances, so the turn moves, balances change, and the UI re-renders
exactly as it would against a chain. Deliberately still not a chain dispatch: `applySandboxAction`
moves turn pointers and counters and **knows no rules** (`utils/sandboxSession.ts #0` for why that
boundary is the whole design rather than an unfinished edge).

### App.tsx #62 — A hand-authored snapshot stands in for the poll
In sandbox the poll is permanently `null` (no client), so a fixture snapshot stands in. Everything
downstream reads `gameState` and is completely unaware of the substitution — **which is the point**:
the panels are being inspected as they will really behave, not through a sandbox-only rendering path
that could drift from the real one.

Memoised, because `gameState` sits in the dependency array of a dozen hooks; rebuilding the object
every render would give it a new identity and re-fire all of them continuously.

It is **real state**, not a `useMemo` recomputed from the phase — that made it immutable by
construction, so every dispatched action had nowhere to write and the sandbox could only depict one
frozen moment.

The seeding effect keys on the phase toggle: switching phase is a **debug** action meaning "show me
that screen", so it deliberately discards whatever the loop had accumulated and starts that phase
clean. Preserving mutations across a phase jump would produce states the real game can never reach.

---

## Viewer identity

### App.tsx #25 — Who the dashboard should think it is looking at
In sandbox there is no wallet, so `wallet.address` is `null` — and every turn-gated control compares
the connected address against the active player. The result was a sandbox where the Auction and Stock
Round rendered **entirely disabled**, which is close to useless for judging layout: you cannot polish
a control you can only see greyed out. Seating the viewer as the sandbox's first player puts the
panels in their live, enabled state.

**READ-ONLY IDENTITY.** This is used for **display** and **enablement** only — whose cash to show,
whose holdings to mark "you", whether a control is live. It is deliberately **not** used for anything
that signs: every dispatch still goes through `wallet.address`, and in sandbox `runGameplayAction`
refuses before building a message at all. A pretend identity that could sign would be a genuinely
dangerous shortcut; one that can only light up a button is not.

### App.tsx #534 — In a room, you are yourself
**Reported:** the sandbox lets the local browser act for every player, because it was built as an
offline hotseat.

`viewerAddress` is the **single identity input** to everything that gates an action: `isMyTurn`
compares it against the acting seat, and every `canAct` compares it against a corporation's president.
The hotseat worked by making it a **seat picker** — whoever the player selected is who they are, which
is exactly right when one person is playing everybody.

So the whole fix is one branch. In a Firebase room this browser is one person with one id (`#528`),
and pointing `viewerAddress` at it makes **every existing gate correct at once** — rather than adding
a second "is it my turn" test beside the dozen that already exist and hoping the two agree.

`#534` also required declaring this browser's identity and its room **early**, above `viewerAddress`,
because that value is derived from both. Only the two things identity depends on are hoisted; the rest
of the room's state stays below with the listener that drives it, so the move is as small as the
dependency.

*(Simplified by `#578`: in a sandbox you are the seat this browser holds, full stop. The fork that
resolved a hotseat's "current seat" is gone with the hotseat.)*

### App.tsx #536 (identity ref) — Mirrored into a ref for the turn gate
A dependency would rebuild `runGameplayAction` on every turn change, and the auto-skip and
forced-withhold effects (`#439`) key on its identity — so a turn passing would re-arm two effects
that **dispatch**.

### App.tsx #546 — Refs for declaration-order problems
The established shape in `App.tsx` for reading something declared later in the file. Here a ref is
additionally the **safe** choice: `runGameplayAction` sits in the dependency array of the two effects
that dispatch, so naming it as a dependency of a handler would be one more identity to keep still.

*(Contrast `#553` in `stock_market.md`, which is written **during render** rather than in an effect,
and states exactly why the two differ.)*

### App.tsx #578 (type narrowing) — A render gate is not a type
The room is guaranteed by the gate that refuses a roomless sandbox a board, but the ref is still typed
nullable and the compiler is right to insist. A guarantee held by a render gate several thousand lines
away is not one a type can see, and narrowing at the use site is cheaper than asserting it.

### App.tsx #536 (courtesy half) — Controls go dead off-turn
In a room the controls go dead off-turn so a player is not invited to click something the dispatch
gate will refuse. *(`#578`: always a room, so always turn-gated.)*

### App.tsx #536 (train offers) — Who may answer
**Sandbox:** the prompt names the seller, so the person clicking Accept is told whose decision they
are standing in for. **Online:** `liveTrainOffer` only exists when the viewer **is** the seller's
president, so reaching it with a live offer already means the right person is being asked.
*(Superseded for privates by `#662` — see `contract_economy.md`.)*

---

## Train offer consent

### App.tsx #414 (fork) — Who has to agree, decided in the shell
Decided in `App.tsx` rather than in the panel because only the shell knows which deployment it is in:

| Case | Behaviour |
|---|---|
| **Same president** | One player controls both corporations, so there is nobody to ask. `train_trade.rs` settles on the spot and writes no offer; the sandbox reducer's `BuyTrainFromCorporation` arm does the same. Dispatch immediately. |
| **Different presidents, online** | Dispatch, and the contract records an offer the seller's own client will poll and answer. Real two-party consent, carried by the chain. |
| **Different presidents, sandbox** | No chain to record it in, so the proposal is held locally and the prompt is shown. Accepting sends the same `BuyTrainFromCorporation`; rejecting sends nothing. |

### App.tsx #218 — The counterparty gets the same prompt online
The consent modal was sandbox-only, on the reasoning that a live room does not need one: the contract
records the offer and the seller's president can answer it from `TrainTradePanel`'s pending-offer
ledger.

**True about the messages and wrong about the interaction.** The ledger is a row in a panel that
renders only during the Hardware sub-phase, so the one player whose answer the game is waiting on is
also the player most likely not to be looking at it. Meanwhile the **buyer's** turn is blocked on that
answer (`operations::PendingTrainOfferBlocksTurn`), so an unnoticed row stalls the table with no
indication of why.

**A pending offer addressed to you is an interruption, and it should interrupt.** The same
`TrainTradePrompt` the sandbox shows is derived from the **chain's** own offer register
(`GetTrainOffers`, already polled) whenever the viewer presides over the selling corporation. **One
component, one affordance, two sources.**

What differs is only the plumbing: accepting sends the real `AcceptTrainOffer` and rejecting the real
`RejectTrainOffer`, both addressed by `offer_id`. The ledger stays exactly as it was — it still lists
every offer in the room including ones this player is not party to, which the prompt deliberately does
not (`#1` there: a pending offer is public information, but only one person is being asked).

**One at a time.** `find` rather than a queue: `train_trade.rs` permits one outstanding offer per
buying corporation, and stacking prompts for several sellers would be a modal pile-up for a state the
contract makes rare.

### App.tsx #233 — The offers this viewer is party to
As the **seller** who must answer, or as the **buyer** whose turn is held open by their own
outstanding offer. Anything else in the room is somebody else's negotiation and does not warrant a
panel on this player's buy screen. *(In the old solo sandbox every offer qualified, because one human
drove every seat.)*
