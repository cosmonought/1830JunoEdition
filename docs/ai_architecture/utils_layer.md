# The `utils/` Layer — Contract Mirrors, Polling Hooks, Derived Helpers

The hand-kept TypeScript mirrors of `src/msg.rs`, the polling hooks that fetch them, and the pure
helpers that read them. Anchors are `<source file> #<N>`. Search the number.

> **One-way import rule.** `utils/` may not import from `components/`. Where a helper needs a fact that
> lives in a component — the market-zone table, for instance — that fact arrives as a **callback
> parameter**, which keeps the boundary intact and the helper pure and testable. See
> `gameState.ts #7`.

---

# `utils/gameState.ts`

## The mirror

### gameState.ts #1 — Hand-kept mirror, not codegen
There is no schema-derived TS type for `GameStateResponse`, **so every field here must be kept in exact
sync with `src/msg.rs` by hand any time that struct changes.** The same DESIGN GAP as every other
contract-data mirror in this codebase (`HexGridRenderer.tsx #2`, `StockMarketRenderer.tsx #1`). Verified
field-for-field against `msg.rs` for the pass that wrote this: `GameStateResponse`, `PlayerCashEntry`,
`PlayerShareEntry`, `PublicCompanyState`, `PrivateCompanyState`.

### gameState.ts #2 — What this deliberately does NOT expose, because the backend does not either
`src/state.rs` genuinely models hardware/train inventory (`HardwareAsset`, `HARDWARE_POOL`,
`COMPANY_HARDWARE`, `TRAINS_PURCHASED_COUNT`) and route-tracing (`pathfinding.rs`) — **but NO `QueryMsg`
variant returns any of it, and `PublicCompanyState` has no hardware/train/route field at all.**
**This file does not invent one.** Every panel that would want that data must render an honest "not yet
exposed by the contract" state instead of a fabricated number — see `ContextualSubPanel.tsx` and
`FinancialLedger.tsx #3`.

### gameState.ts #4 — Polling, not a subscription
**CosmWasm has no push/subscription query mechanism reachable from a browser** the way this project is
wired (a plain `CosmWasmClient`/`SigningCosmWasmClient` over RPC). `useGameStatePolling` re-fires
`GetGameState` on a fixed interval (default 6s) plus once immediately whenever the client, contract
address or game id changes.
**A monotonic request-sequence guard discards a stale in-flight response if a newer poll already
resolved first** — mirroring `HexGridRenderer.tsx #7`'s click-interceptor staleness guard.

### gameState.ts #6 — Net worth is a separate hook, not a field
`QueryMsg::PlayerNetWorth` takes a **per-player** `wallet_address` that `GetGameState` has no equivalent
for, **so one room-wide poll cannot answer "what is EACH player's net worth" in a single call** the way
it already answers "what is each player's cash". `usePlayerNetWorths` fires one query per address via
`Promise.all` — **concurrently, so this scales to a full player table in one round-trip-latency's worth
of time, not N of them.**
**Its `refresh` depends on the JOINED address key, not the array.** Every poll returns a fresh JSON
parse, so a same-content-but-new-reference `player_addresses` **would otherwise tear down and rebuild
this hook's interval every 6 seconds in lockstep. Only an actual membership change does.**

### gameState.ts #7 (waterfall) — A third independent hook, gated by the caller
Mirrors `WaterfallStateResponse` and friends exactly, on the same fixed-interval-plus-monotonic-guard
pattern. **A separate hook rather than a field on `GameStateResponse` because `GetWaterfallState` is its
own query and, unlike `PlayerNetWorth`, is only ever meaningful while `current_round_type ===
"WaterfallAuction"`** — so every other panel keeps polling `GetGameState` alone **without ever paying for
a query whose response it never renders.** When `enabled` goes false the hook tears down its interval and
clears state rather than continuing to query a phase that is already over.
The mini-auction bidder queue is **ascending by the bid each held when the contest opened, so the lowest
bidder is always first to answer** — see `sandboxSession.ts #544` for why the queue is fixed at that
moment rather than re-sorted after every raise.

### gameState.ts (train offers, G-15) — Its own hook, and it cannot key off turn state
Offers change on a different rhythm from the board — **they appear and vanish on two players' actions
rather than on turn boundaries — and a seller needs to see one arrive while it is emphatically NOT their
turn.**

### gameState.ts (offline-awareness) — An unset contract address is a supported state
`null`/`undefined` means the app has no configured contract, **which is a supported state, not an error**
— the same offline mode `HexGridRenderer`'s tile-catalog fallback runs in. The hook clears state, stops
loading, and never queries. **Typed optional rather than coerced to `""` at the call site, so the offline
case cannot be mistaken for a real address that happens to be empty.**
`error` is set on the most recent failed query and **NOT cleared just because an earlier successful state
is still displayed** — callers that want "stale but still show the last good state" can keep rendering
while surfacing `error` as an inline note, **matching this codebase's "never silently hide a failure"
discipline.**

## Fields whose optionality carries meaning

### gameState.ts (last route revenue) — `undefined` ≠ `"0"`
Written by `operations::execute_run_manual_route` on EVERY run, paid out or withheld alike, **and reset
to zero by a run that found no legal route — so it always reads as "what it earned last time", never a
stale high-water mark.**
**Optional because a contract predating the field returns no key at all, and `undefined` must stay
distinguishable from a real `"0"`: the first means "this build cannot tell you", the second means "it
earned nothing".**

### gameState.ts (owned trains, G-15c) — Unknown is not empty
The MODEL of every train a corporation owns, with **duplicates meaningful.** `undefined` means a contract
predating the field, i.e. **"unknown", NOT "owns nothing". A UI that conflates the two would grey out
every train on every corporation against an older chain and make trading look broken rather than
unsupported.**

### gameState.ts (priority deal) — A real field the contract does not yet move
Per `state.rs`'s own doc comment it is currently static `0` for every room — **nothing yet reassigns it
during play on chain.** The SANDBOX reassigns it at the end of a Stock Round (`sandboxSession.ts #353`),
**which is the rule the contract will apply when it implements its own half.**
The Priority Deal marker's hover text is **defined once and shared by every surface that renders it**, so
two panels cannot drift into explaining the same indicator two different ways — **which is exactly what
happens when a tooltip string is retyped per call site.**

### gameState.ts #352 / #656 / #662 — Sandbox-only fields, marked as such
**Neither comes off the wire.** `GetGameState` does not report them and a live room leaves them
`undefined`, which every reader treats as "not applicable" rather than as a value. **Marked optional
rather than added to the mirror of the contract's response shape, so nothing here can be mistaken for a
field the chain will one day send.** They live on the state object rather than in module scope because
**the undo snapshot copies the state; it cannot copy a closure** (`#352`).

- **#352** — the seat that last bought or sold this Stock Round, for the Priority Deal handover.
- **#656 — WHICH STEP of its turn the acting corporation is on.** This was React state in `App.tsx`,
  re-seeded by an effect keyed on the era and phase tier — **so buying a train that advanced the phase
  sent the buying corporation back to the top of its own turn.** A cursor held outside the reducer is also
  **not in the action log**, so a client that joined or undid mid-turn rebuilt every treasury exactly and
  then showed whichever step its own effect seeded. **Same split `#642` found in the round machine, one
  layer down.** Sandbox-only: **a live room leaves it undefined because the CONTRACT owns the cursor there**
  (`or_phase`, and `WrongOperatingSubPhase` when a client disagrees). **Readers treat `undefined` as "ask
  the opening rule", never as a step.**
- **#662 — the private-company purchase awaiting its owner's answer.** On the STATE rather than in a React
  ref **because a proposal is something the other player has to see, and the sandbox's shared state is the
  only thing both clients hold. It was a ref in `App.tsx` — so the seller was never asked and the buyer
  answered their own offer.** The contract's `BuyPrivateCompany` is single-party (it reads `private.owner`
  and never consults them), **so there is no chain-side offer for this to mirror.** Snake_case to match
  everything else on the response, even though no contract sends it: **a reader scanning this object should
  not have to work out which fields came off the wire from their casing.**

## Certificates

### gameState.ts #3 — Derived but EXACT, not a backend count
`state.rs` has an internal `count_player_certificates()` helper, **but it is used only inside
`trading.rs`/`auction.rs`'s own limit checks — no query surfaces its result.** The count is reconstructed
exactly from what genuinely is queryable: private owners, player holdings, and the president field.
**A president's 20% certificate counts as exactly ONE certificate against the limit — not two, despite
representing double the ownership.** Verified against three independent sources (the official Lookout
Games rulebook, the 18xx.net rules text, and the `tobymao/18xx` engine's own `num_certs`/`cert_size`
implementation — see `rules_and_sourcing.md`). **An earlier pass of this comment said the rule was
deliberately left unimplemented because it had not been confirmed against source; that premise no longer
holds on either count.**
**The function was renamed from `estimateCertificateCount` and the "~N" presentation went with it.** The
name was inherited from a pass where the rule was unconfirmed and the count really was a guess. **Nothing
here approximates anything.** Equivalent to `(total public % / 10) − presidencies held + privates held`.
**The one thing it still cannot do is see a certificate the QUERIES do not expose — but no such
certificate exists in the current schema, so that is a statement about future changes, not about present
accuracy.**

### gameState.ts #7 — The certificate-limit exemption, and why the zone arrives as a callback
Shares of a corporation whose market price sits in the Yellow, Orange or Brown zone **do not count toward
a player's certificate limit. That is a MARKET-POSITION rule, not an ownership rule: the same certificate
counts today and stops counting tomorrow if the price moves up into a zone, with nothing about the
certificate itself changing.**
**The zone table lives in `StockMarketRenderer.tsx`, and `utils/` may not import from `components/`.**
Taking `zoneForPrice` as a parameter keeps that boundary intact **and** keeps this function pure and
testable, **rather than copying the price-to-zone table into a second place where it could drift from the
board a player is looking at.**
**Omitting the callback is a valid call, not a degraded one:** the caller simply has no market data.
Everything is then counted, **which is the correct conservative answer — a corporation with no market
position is not in any zone.**
**Private companies are never exempt.** They have no market price at all, so there is no zone for them to
be in.

### gameState.ts #526 — The certificate-limit table has one home
The local copy is gone. **It carried its own doc comment saying "Mirrors `RulesReference.tsx`'s
`CERT_LIMIT_BY_PLAYERS`" — a correctness requirement enforced by a sentence, which is the arrangement
TD-1 catalogued and `StockRoundPanel.tsx #507` hit again.** `utils/gameSetup.ts` is the one table now;
multiplayer initialisation needed it too, **and a third copy is what this delegation exists to avoid.**

## Who acts next

### gameState.ts (acting seat) — Two different pointers, and which is correct depends on the round
- **Waterfall Auction and Stock Round are seat-driven.** Players act in seating order, so
  `active_player_index` is the answer directly.
- **Operating Rounds are corporation-driven.** The queue names companies, not people, and the human who
  may act is whoever presides over the company currently up. **The seat pointer is not meaningful here and
  can easily point at a player with nothing to do.**

Returns `null` when the acting seat cannot be resolved — an Operating Round whose current corporation has
no president on record, for instance. **Callers should leave the seat where it is rather than guess.**

### gameState.ts #544 — A mini-auction suspends the turn order
**Reported:** a player bought a private, which opened a mini-auction they were the lowest bidder in. The
mini-auction card named them as being on turn. The Turn Order named them. **The Auction Round ACTION
PANEL named somebody else — and only that somebody else could do anything.**
The acting-seat helper returns `active_player_index` during the auction, **and that field is right about
the WATERFALL and knows nothing about a contest running on top of it.** The mini-auction's cursor lives
on a different document, on a different atom, fetched by a different query. **So the two halves of the
screen were each reading a pointer that was correct about a different question, and neither was wrong on
its own terms.**
**The suspension is the whole rule.** While a contest is live the main rotation does not advance and
nobody may take a waterfall action — **the reducer has preserved `waterfall.current_turn` across a
contest since `#338` precisely so it can be resumed untouched. That makes it a STALE pointer for the
duration, and anything asking "who may act" has to prefer the contest's cursor.**
**Why an address and not a seat index:** a mini-auction bidder is identified by address, **and mapping
back to a seat only to have callers map forward again would add a lookup that can fail (a bidder missing
from `player_addresses`) to a path that currently cannot.**
**The narrower helper is left alone.** It answers "which SEAT the phase points at", which the sandbox
seat-switcher and the Operating Round president lookup both still want. **Widening it would have meant
threading the waterfall document through every caller, including several that have no business knowing an
auction exists.**
`isSidelinedByMiniAuction` states a real fact about the game rather than a visual one: **these players
cannot act, and cannot be acted for, until the contest resolves** (`ContextualActionBar.tsx #545`).

### gameState.ts #553 — A corporation's par is the corporation's, not yours
**Reported:** the president founds a corporation at $67 and their Buy button goes on saying $67. Every
other player is shown $100 and pays $100 — **and the two clients then place the corporation's market token
in different boxes.**
The resolver read the local par **LADDER**, falling back to a hardcoded `"100"` when this browser had
never touched it. **The ladder is a UI selection: it exists so the founding buyer can choose a price. It
is per-browser by design and empty on every client but the one that made the choice, so everybody else
fell through to the default — which happens to be the top rung, which is why the wrong number looked like
a plausible one.**
**So the ladder is an INPUT, and the par is a FACT.** Once the founding purchase lands,
`PublicCompanyState.par_value` holds the answer, it came off the shared state, and every client has it.
The ladder is consulted only while that field is still empty — **which is exactly what `#351` already said
the rule was; the reducer honoured it and the price the UI quoted and dispatched did not.**
**The same bug as `#549`, one layer up.** There the reducer resolved WHO from local state; here the UI
resolved HOW MUCH from local state. **Both are the same mistake — deriving a shared fact from a
per-browser value — and both produce the same shape of failure: no error, two clients that disagree, and a
symptom that surfaces somewhere else entirely (here, the stock market chart).**

## Privates, by owner

### gameState.ts #379 — A private can belong to a company, not a player
**Reported:** when a corporation buys a private from a player, there is nowhere in the UI to see that the
corporation now owns it.
**`PrivateCompanyState` has carried BOTH owners since the schema was written** — `owner` for a player and
`owner_protocol_id` for a corporation, "mutually exclusive" per its own doc comment — and the phase-gated
corporate purchase that sets the second has been implemented since `PrivateTradePanel`. **Every reader in
the app looked only at `owner`. So the moment a private crossed from a player to a company it left the
seller's ledger row and arrived nowhere: it paid revenue to a treasury (`#329`) that no surface attributed
to it.**
**One helper**, so the ledger column and the Operating Round strip cannot disagree about what a
corporation owns.
**Closed privates are excluded**, matching the sellable-privates helper and the reservation badges: **a
closed company is off the board, pays nothing, and listing it would show an asset the corporation no
longer has.**

### gameState.ts (player privates) — Two lists, deliberately
The plain list **includes closed privates still on this player's own ledger** (e.g. a Phase 5-closed
private they held at closure) — that is a certificate-tree question. The *sellable* list excludes them,
because **a closed private permanently rejects `execute_buy_private_company` (`trading.rs` module doc
#17), so offering one would just produce a guaranteed-failing tx.** The Buy Private Company tray uses the
second, not the first.
