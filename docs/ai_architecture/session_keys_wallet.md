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

---

# Batch 5C — The full session-key stack

## utils/sessionKey.ts — the ephemeral browser key

### sessionKey.ts #1 — Key generation
`@cosmjs/crypto`'s `Random`/`Secp256k1` (a CSPRNG wrapper plus curve validation), then the raw scalar wrapped in a
`@cosmjs/proto-signing` `DirectSecp256k1Wallet`. **`@cosmjs/amino`'s `Secp256k1Wallet` is the equivalent for
amino-style signing (what Keplr's injected signer typically uses); direct protobuf signing was chosen because it is
the simpler, more standard path for a locally generated key that never touches Keplr's UI, and CosmWasm's
`MsgExecuteContract`/`MsgExec` are natively protobuf either way.**

### sessionKey.ts #2 — `sessionStorage`, not `localStorage`
The private key **should not survive a browser restart or be shared across tabs once this tab closes.** A stolen
session key **can only ever do what its authz grant allows** (`ContractExecutionAuthorization` +
`AcceptedMessageKeysFilter` scoping in `WalletContext.tsx`) **and spend whatever the developer FeeGrant covers —
never move the player's real JUNO — which is the whole point of keeping it this narrowly scoped.**

### sessionKey.ts #3 — `GAMEPLAY_MESSAGE_KEYS` is the single source of truth
`WalletContext.tsx` imports **this exact array** into the on-chain grant's `AcceptedMessageKeysFilter` **so the
client-side allow-list and the on-chain enforcement can never drift apart.** `execViaSessionKey` also asserts
against it locally, **so a coding mistake fails fast in the browser instead of as an opaque on-chain rejection.**

**Deliberately EXCLUDES `CreateGameRoom`, `JoinGameRoom` and `EndGameAndDistribute` — those move real JUNO and stay
Keplr-signed** through `WalletContext`'s `signingClient`. **Every other `ExecuteMsg` variant is pure VGP/gameplay
state and is safe to delegate.**

### sessionKey.ts #4 — Wire-format correction vs. the blueprint
`msg.rs`'s `ExecuteMsg` has **no `#[serde(rename_all = ...)]`, so it serializes with serde's default *externally
tagged* representation — the JSON key is the exact Rust variant name, e.g. `{"BuyStock": {...}}`, NOT
`{"buy_stock": {...}}`.** `SharePurchaseSource` is the same: `{"Ipo"}`/`{"Bank"}`, not lowercase. **The blueprint's
inline call-site examples used the wrong casing.** `GameplayExecuteMsg` is the corrected, exact-cased type.

Variant keys are **PascalCase while their fields stay snake_case** — fields serialize as literally named in the
Rust struct (already snake_case in `msg.rs`); **only the enum's externally-tagged variant name follows serde's
PascalCase default.**

### sessionKey.ts #5 — `Any` must be real protobuf bytes
`MsgExec.msgs` is `repeated google.protobuf.Any`, and `Any` is a real protobuf wrapper (`{ typeUrl, value:
Uint8Array }`) — **the inner `MsgExecuteContract` MUST be encoded with `.encode(...).finish()` before being placed
in that array. Passing a decoded/plain object as `Any.value` (as an earlier sketch did) encodes successfully
client-side but fails to decode on-chain, since the chain's `Any` unpacking expects real protobuf bytes, not JSON.**

**Only nested `Any` fields need pre-encoding.** The OUTER `MsgExec` is passed to `signAndBroadcast` as a plain
`typeUrl`/`value` `EncodeObject`; **the extended registry encodes it automatically.**

### sessionKey.ts F-4 — The placeholder that was the actual bug
`DEVELOPER_FEE_GRANTER_ADDRESS` used to be the literal string `"juno1...devfeegrantaddress..."`, **which is not
valid bech32 — and since every gameplay transaction routes `granter: feeGranter`, EVERY session-key transaction
would have failed at fee-grant resolution the moment this pointed at a live chain. Nothing caught it earlier
because nothing validated it: the failure surfaced at broadcast, as far from the mistake as it is possible to get.**

`../config` now reads all four from the environment. **It is also the single definition shared with
`WalletContext.tsx`, which matters specifically for `CONTRACT_ADDRESS`: this file's copy scopes the authz grant's
`ContractExecutionAuthorization` while that file's copy signs it, and two drifting copies would authorize a
contract the app never calls.**

### sessionKey.ts — `createExtendedRegistry`
Extends CosmWasm's default registry with the full `x/authz` set: **`MsgExec` (session key) and
`MsgGrant`/`MsgRevoke` (master wallet). Neither client works without this — a `SigningCosmWasmClient` built with
the plain default registry throws "Unregistered type url" the moment it tries to encode any of these, which only
surfaces at broadcast time, not at connection time.** Both signing clients **MUST** be constructed with this same
factory rather than two independently-assembled registries, **precisely so this list cannot drift out of sync.**

### sessionKey.ts — Fee granter and key disposal
`feeGranter` **defaults to `DEVELOPER_FEE_GRANTER_ADDRESS`**, overridable per-call (e.g. a per-tournament sponsor),
**but every gameplay tx should set *some* feeGranter — the session key itself is never expected to hold JUNO to pay
gas with.** `clearSessionKey` **only forgets the key locally; callers should also broadcast a `MsgRevoke`
(`WalletContext.revokeSessionKey`) if the on-chain grant should stop working immediately.**

### sessionKey.ts — `RouteWaypointDto`: the unit of a route is a STATION, not a hex
Exact mirror of `msg.rs`'s `RouteWaypoint`. **That distinction became load-bearing when the contract's pathfinder
moved its path history to `(hex, city_node)` keys, so a route can legally serve BOTH stations of a two-city hex —
New York's brown tile (#62) and every OO tile carry two independent cities on physically separate track.** The old
payload was `hex_path: string[]`, **which could not say which of the two a stop meant, so the contract had to
refuse any repeated hex label outright rather than guess and risk paying for a stop the train never reached.**

`city_node` is **OPTIONAL and omitting it is the normal case** — "this hex has one stop, or none", which is almost
the whole board. Indexed exactly like the contract's own city registries (`0` first city, `1` second). **Naming a
city the hex does not have is rejected on-chain with `NoSuchCityOnHex` rather than silently coerced.**

### sessionKey.ts — Message-variant notes
- **`AdvanceOperatingSubPhase` (Audit G-14):** advances past the current OR sub-phase without acting in it. **The
  six OR actions are gated on-chain against a persisted cursor, so this is the only way past a phase the
  corporation has nothing to do in — and every skip is a recorded, replayable event rather than a client-side jump.**
- **`BuyPrivateCompany`** — the Phase-Gated Corporate Purchase Protocol (`trading.rs #17`): a corporation buying a
  player-owned private's wrapper into its treasury once Phase 3 has launched. **`price` is a string for the same
  big-int-safety reason every other `Uint128` field is.**
- **`LayTile.orientation` is a required, explicit, player-chosen field.** A prior contract version **auto-picked the
  lowest legal rotation server-side and took no `orientation` input at all, which silently removed a real 1830
  strategic choice (which direction a route extends).** `TileSelectionPopup.tsx` is the only caller and always
  sends the player's actual selection.
- **`RunManualRoute.path`** replaced the deprecated `hex_path: string[]`. **Only `protocol_id`'s registered
  President may send it, and it requires `BeginOperatingRound` to have populated the OR Corporation Turn Queue
  first.**
- **`PlaceStationToken.city_index` is OPTIONAL and additive**: a hex carrying two separate cities (New York #54/#62,
  the OO tiles) needs it to be answerable at all; on a single-city hex the only valid value is `0`. **Omitting the
  key entirely makes the contract resolve the lowest-indexed city with a free slot — always a legal placement
  rather than a rejection.**

---

## context/WalletContext.tsx — the master Keplr wallet

### WalletContext.tsx #1 — What the master signer is for
Exactly the things blueprint Section 0 scopes to Keplr: **`CreateGameRoom` / `JoinGameRoom` /
`EndGameAndDistribute` (real JUNO movement) and issuing/revoking the session key's authz grant.** Every in-game
gameplay message goes through `execViaSessionKey` instead.

### WalletContext.tsx #2 — The grant is narrowly scoped
`ContractExecutionAuthorization` + `AcceptedMessageKeysFilter`, restricted to **this one `CONTRACT_ADDRESS`** and to
**`GAMEPLAY_MESSAGE_KEYS` imported from `sessionKey.ts`, the single source of truth, since the two files must never
drift.** **This corrects and supersedes the broader `GenericAuthorization` sketch in blueprint Section 2.1**, which
that document already flagged as a pre-mainnet gap.

### WalletContext.tsx #3 — Only a public address is cached
**Only the master wallet's public `juno...` address is ever written to `sessionStorage`** — purely so the UI can
show "reconnect as juno1..." — **never key material. Keplr custodies the actual signing key; this app never touches
it.**

### WalletContext.tsx #4 — The extended registry, again
`MsgGrant`/`MsgExec`/`MsgRevoke` are not in `SigningCosmWasmClient`'s default registry, **so both this file and
`sessionKey.ts` must construct their clients with `createExtendedRegistry()`. Omitting it is a common, silent
failure mode — the client throws "Unregistered type url" only at broadcast time, not at connection time.**

### WalletContext.tsx #5 — VERSION CAVEAT (unresolved)
The int64 fields (`Grant.expiration.seconds`, `MaxCallsLimit.remaining`) are built with plain `BigInt(...)`,
**matching `cosmjs-types` 0.9+ which targets native `bigint` for int64. Older `cosmjs-types` represented these with
the `Long` class from the `long` package, which would need `Long.fromNumber(value)` instead.** This file was
written and syntax-checked **without network access to a real `node_modules`** — **confirm against the installed
`cosmjs-types` version's generated `.d.ts` before shipping, and adjust both this file and `execViaSessionKey` if it
is on the older `Long`-based generation.**

### WalletContext.tsx F-3 — The real `ujuno` balance is a `Coin`, not a number
Deliberately `{ denom, amount }` with `amount` a **base-denom INTEGER STRING**. Two reasons, **the second being the
important one**: it is exactly what `getBalance` returns, so nothing is reinterpreted on the way through; and
**`ujuno` amounts are `Uint128` on-chain, so converting to a JS number loses precision above 2^53 base units —
which is a real balance, and the failure is silent: the UI would simply show the wrong amount of the player's own
money.**

**DISTINCT FROM VGP.** This is real spendable JUNO, which is what the lobby ante is denominated in. **The
dashboard's existing balance figure is `player_cash` — Virtual Game Points, the in-game play money. Conflating the
two is precisely the confusion F-3 was filed about, so they must never share a display slot or a label.**

Balance query errors are **swallowed into `null` rather than surfaced through `error`: that field drives the
connect/disconnect UI, and a transient RPC hiccup on a balance read must not make the wallet look disconnected. A
`null` balance renders as "unavailable", which is the honest state.** No second client is needed — **
`SigningCosmWasmClient` extends `CosmWasmClient`, which exposes `getBalance` from the Stargate bank module.**

**Stale-account guard:** if Keplr's active account changes out from under the app mid-session, **every subsequent
signature would silently be attributed to the wrong player.** Tracked in a **ref, not state**, purely so the
`keystorechange` listener always reads the latest `disconnect` **without re-subscribing on every render.**

### WalletContext.tsx F-4 — Deferred config reads
The chain id, RPC endpoint and contract address were local copies duplicated in `sessionKey.ts`; both now read from
`../config`. **The `require*()` accessors throw if a value is unset or still a placeholder — but only when CALLED,
which is always inside a path about to touch the chain.** Reading raw `CONTRACT_ADDRESS` never throws and may be
`undefined`, **which is what lets the app boot and run offline with no `.env` at all.**

---

## context/GameSessionContext.tsx — the provider the utilities never had

**DESIGN GAP CLOSED:** Milestones 1-2 shipped only the *utilities* — key generation/caching, the authz-wrapped
executor, and `grantSessionKey` — **never a Provider wrapping them into one piece of React state.** App.tsx needs
that boundary to hold the key/client across re-renders and expose a single `execGameplay`.

1. **`initializeSessionKey` does two things in sequence:** (a) materializes (generating if needed) the cached
   keypair and its signing client, then (b) broadcasts the authz `MsgGrant` signed by the connected master wallet.
   **Both must succeed before `execGameplay` works — generating the key alone grants it nothing on-chain, and a
   grant for an address whose key was never cached would be unreachable from this browser.**
2. **Must render INSIDE `WalletProvider`** — it calls `useWallet()` internally and throws the same
   "must be used within a Provider" error if nested the wrong way.
3. **Re-running `initializeSessionKey` is safe** (e.g. a mid-session reload): `getSessionWallet` reuses whatever key
   is cached in `sessionStorage`, **and re-broadcasting the same (contract, grantee, message-key-filter) `MsgGrant`
   simply replaces the prior grant with a fresh expiration on `x/authz` rather than stacking a duplicate.**
4. **`execGameplay` is a thin wrapper** over `execViaSessionKey`, filling in the session client/address and the
   master address automatically **so call sites only supply the `GameplayExecuteMsg` itself.**

---

## components/ConnectWalletButton.tsx — the burner-wallet checkpoint

### #0 — Why a component and not a modal prop
**There is more than one Connect Keplr button in this app** — the top bar and the lobby's own — **and a warning
that only one of them honours is not a warning, it is a coin flip.** So the button and the modal ship as ONE
component. **`wallet.connect` is not exported from here and no caller wires it directly; bypassing the
recommendation means deleting this component, which is a visible change rather than an easy omission.**

### #1 — This is advice, and it does not pretend otherwise
**The modal cannot verify that the wallet a player picks in Keplr is actually a burner — nothing in the browser
can.** It is a recommendation shown **at the one moment it is actionable, which is the moment before the extension
opens**, and it says so plainly.

**NOT dismissible-forever and no "don't show again" toggle**, unlike `TutorialModal`: **a tutorial teaches
something once; this is a checkpoint on a security decision that is re-made every time a different wallet could be
selected.** It is one extra click on a once-per-session action, **and Cancel is a real exit — the point is a
considered choice, not a toll booth.**

### #2 — Escape and backdrop mean Cancel
Both dismissal paths route to Cancel, **never to Proceed. A modal that opened a wallet connection because someone
pressed Escape would be doing the opposite of what the gesture means, and this particular modal exists to slow that
decision down.**

---

## config.ts — deployment configuration (F-4)

### config.ts #0 — Why this file does not throw at import
The first version validated at module scope (`export const CONTRACT_ADDRESS = requireAddress(...)`). **That crashed
the entire app at startup with an unset `.env` — the throw happened during `import`, before React ever mounted, so
there was no UI left to display the error in.** `config.ts` ← `sessionKey.ts` ← `WalletContext.tsx` ← `App.tsx`:
**one missing variable took down the whole bundle.**

**It was also wrong on the merits.** This app has a real **OFFLINE MODE** — `HexGridRenderer #120`'s tile-picker
fallback, which reads `localCatalogPlacements` and reports `status: "offline"` whenever `contractAddress` is
`undefined`. **Offline mode needs no contract, no fee granter, no RPC endpoint and no wallet; it exists precisely
to inspect the tile catalog without a chain. Making an unset contract address fatal made that documented mode
unreachable.**

**The rule:**

| Operation | Behaviour |
|---|---|
| **READING** config | never throws. Unset values are `undefined`, **which is a legitimate state meaning "offline"** |
| **REQUIRING** config | throws, **and only at the moment an operation genuinely needs a chain** — connecting a wallet, granting a session key, sending a transaction |

**Still fail-loud** — the error names the exact variable — **but it fails at the point of use, where the UI is
alive to show it and where the user has actually asked for something that needs it.** The original bug (a
placeholder that LOOKS like an address) **is still caught by `requireAddress`; it just does it when you try to
transact rather than when you open the page.**

### config.ts #1 — Why a shared module at all
`WalletContext.tsx` and `sessionKey.ts` each carried their own RPC endpoint and contract address, **each with a
matching `TODO(design gap)` acknowledging the duplication.** Not merely untidy: **`sessionKey.ts`'s copy scopes the
session key's `ContractExecutionAuthorization` while `WalletContext.tsx`'s copy signs it. Two drifting copies would
authorize a contract the app never calls, and every session-key transaction would fail authorization at broadcast
with no hint as to why.**

### config.ts #2 — CRA substitutes `REACT_APP_*` at build time
`react-scripts` replaces `process.env.REACT_APP_FOO` **textually**. Two consequences **worth stating rather than
discovering:**

- **The reads MUST be full literal `process.env.REACT_APP_FOO` expressions.** Destructuring
  (`const { REACT_APP_FOO } = process.env`) or dynamic indexing (`process.env[name]`) **is NOT substituted and
  silently yields `undefined` in a production bundle.** That is why `readOptional` **takes the already-read VALUE
  and uses the name only for messages.**
- **Changing a variable needs a REBUILD, not just a dev-server restart.**

`readOptional` is **EXPORTED for `config/firebase.ts`**, which applies the identical deferred-read discipline to
the `REACT_APP_FIREBASE_*` variables. **Sharing the helper rather than copying it is #1's rule applied to the
reading policy itself: if the definition of "unset" ever changes (say, treating the literal string "undefined" as
blank — a real hazard when a CI system interpolates a missing variable), it must change in exactly one place or the
two config modules will disagree about whether the app is configured.**

### config.ts #3 — Validation is shape-only
Checks the bech32 **prefix, character set and length**. Deliberately does **NOT verify the bech32 checksum**: that
would pull `@cosmjs/encoding` into this module **for no real gain, since the failure being guarded against is
"someone shipped the placeholder" or "someone left it unset", not "someone typo'd one character of an otherwise
real address". A checksum failure is caught by the chain with a clear error; a placeholder was not.**

**NOTHING SECRET GOES HERE. Everything ships to the browser in plain text.**

### config.ts — the exported values
- **`CONTRACT_ADDRESS`** — `undefined` is a supported, meaningful state: `HexGridRenderer` takes it as the signal to
  run its offline tile-catalog fallback. **Pass it straight through; do not coerce it to `""`.**
- **`DEVELOPER_FEE_GRANTER_ADDRESS`** — **MUST equal the contract's own `GameConfig::developer_treasury`.** The
  contract funds this account from a percentage of every lobby deposit, and this account then grants fees back to
  players. **Point these at two different addresses and the treasury fills while every player's transaction fails
  for want of a grant.**
- **`isChainConfigured()`** — `false` means offline mode: tile catalog browsable, wallet and transactions
  unavailable. **Use this to label the UI honestly rather than to hide errors — a user who sees "Offline" and a
  reason is informed; one who sees a dead Connect button is not.**

### config.ts — `formatNativeAmount`: integer string math only
`"12500000"` ujuno → `"12.500000"` JUNO. **NEVER `Number(amount) / 1e6`.** This mirrors the contract's own
no-floating-point discipline **for the same reason it holds itself to it: `ujuno` amounts are `Uint128`, and any
balance above 2^53 base units silently loses precision the moment it becomes an IEEE-754 double. The player would
be shown the wrong amount of their own money, which is the least acceptable place to be quietly wrong.**

Returns `"0.000000"` for malformed input rather than `NaN`, **so a surprising RPC response degrades to an
obviously-wrong-but-harmless zero instead of rendering "NaN JUNO".**

`formatNativeAmountCompact` trims trailing fraction zeros (`40000000` → `"40"`, `40500000` → `"40.5"`, `1` →
`"0.000001"`) **for places that report a POOL rather than a wallet balance.** A wallet wants fixed decimals **so
successive balances line up in the same column; a single headline figure reading "40.000000 JUNO" is six characters
of noise around the number the reader wanted.** Built **on** `formatNativeAmount` rather than dividing, **so the
no-floats discipline holds here too — this only ever trims a string it was handed.**
