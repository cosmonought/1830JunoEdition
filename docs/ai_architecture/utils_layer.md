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

---

# `utils/gamePhase.ts`

### gamePhase.ts #1 — The phase is derived, not queried — and it has to be
**There is no `QueryMsg` that returns "the current phase".** The closest thing is `current_global_era`, which is only
`Yellow | Green | Brown` — **three values for six phases. It cannot tell Phase 3 from Phase 4 (both Green), Phase 5
from Phase 6 (both Brown), or describe Diesel at all. A badge built on it alone would have to print "Phase: 3 (Green)"
during Phase 4 — a wrong number in the most prominent chrome in the app, and since `#612` put the phase number first, a
wrong number in the position a player reads first.**
**So the phase is derived from `owned_trains`, and this is exact rather than approximate.** In 1830 the phase advances
the moment the first train of a new tier is BOUGHT, **and a bought train is owned by some corporation from that instant
on. The highest tier owned by anybody therefore IS the phase, with no lag and no special cases:**

- **Rusting does not break it.** A rusted train leaves `owned_trains` — **but rusting only ever happens when a HIGHER
  tier arrives, and that higher tier is what the maximum now reads.**
- **Trading does not break it.** A train sold between corporations stays in play and stays in somebody's list; **the
  maximum is unmoved.**
- **The opening state is correct by construction.** No trains owned means no train has been bought, **which is Phase 2
  — where 1830 starts.**

### gamePhase.ts #2 / #4 — The depot count is derived the same way, and is exact
`state.rs` has a real `HARDWARE_POOL` **but no query reads it back** (the same gap the Ledger's Trains column reports).
The count is reconstructed as `TOTAL[tier] − owned`.
**That subtraction is only sound while no train of the tier has left play, and for THE CURRENT TIER that is
guaranteed: a tier's trains rust only when a higher tier is bought, and buying a higher tier is exactly what stops it
being the current tier.** So the figure the warning depends on is exact, **even though the same arithmetic applied to
an OBSOLETE tier would over-count** — which is why the remaining count **is only ever computed for the current tier,
and nothing exposes a per-tier depot table that would invite the unsound use.**
**#4 — the full depot table is exact, but not by subtraction.** `#2`'s warning still stands and the inventory does not
violate it — **it never applies that subtraction to an obsolete tier. The depot is a strict queue:** 1830 sells
cheapest-first, **so reaching Phase 4 at all PROVES the 3-train depot is empty.** Each tier therefore has an exact
answer with no guesswork:

| | |
|---|---|
| below the current tier | **0**, by the queue rule |
| the current tier | `TOTAL − owned` — **exact here** |
| above the current tier | **`TOTAL`, untouched — none can have been sold** |

**Rusted is not the same as sold out, and conflating them would mislead.** A 3-train's depot stock is exhausted the
moment Phase 4 begins, **but every 3-train already bought keeps running until the first 6-train arrives. `soldOut` and
`rusted` are separate flags for exactly that reason: one says "you can no longer buy this", the other says "these no
longer exist".**

### gamePhase.ts #3 — Unknown is a state, not a zero
`owned_trains` is `string[] | null | undefined`, **and `undefined` means "a contract predating the field" — unknown,
not empty.** If EVERY corporation reports `undefined` this module returns `known: false` and the caller shows the era
without a train number, **rather than confidently announcing Phase 2 on a chain that simply is not telling us. One
corporation reporting a real array is enough to trust the maximum, because a corporation with no trains legitimately
reports `[]`.**

### gamePhase.ts #5 / #6 / #7 — One countdown, one escalation
**#5 — the phase badge and the train chips disagreed, and the badge was wrong.** In Phase 3 with one 3-train left, the
badge read "Next buy (4-Train) triggers Phase 4" while the chip read "rusts after 2 more purchases". **The chip had it
right: the next depot purchase is the LAST 3-TRAIN, and only the purchase after that can be a 4-train.**
**The bug was structural, not arithmetic.** The badge's text was a static string per tier — **it could not count, so it
defaulted to "next buy" and was correct only when the depot happened to be empty.** Both readouts now derive from one
figure: `purchases = depotRemaining + 1` (**empty the tier, then buy the next**).
**The phase change and the rust are the SAME purchase** — buying the first 4-train both starts Phase 4 and destroys the
2-trains — **which is why one number serves both messages.**
**#6 — every tier can count, not just the current one.** A chip for a 2-train wants an answer during Phase 2 as well,
**when the 4-train that will destroy it is still two whole depot tiers away.** The queue makes that countable exactly:
`purchases = (remaining in every tier from current up to trigger − 1) + 1`. **No estimation, and it degrades to the
single-tier figure when the trigger is the very next tier — the two agree by construction rather than by
coincidence.**
**#7 — one countdown, one escalation.** `#5` made the two readouts agree on the NUMBER. **They still disagreed on the
URGENCY**, because each derived its own severity from a different expression — the chips distinguished two thresholds
and **the action bar fired the identical badge at two purchases and at one. So the single most consequential moment in
an 1830 game, the last purchase before a rust, looked exactly like the moment before it. A warning that does not
escalate is not a warning; it is a permanent fixture that players stop seeing.**
`phaseAlertLevel` is **the ONE place that decision is made, expressed in purchases rather than depot stock so it reads
as the question actually being asked. Every caller escalates in lockstep because there is nothing left to keep in
sync.** `critical` is the LAST purchase before the shift, `warn` the one before; `null` for Diesel and on a chain that
does not report ownership — **an unknown countdown must not render as an urgent one.**

### gamePhase.ts #8 — A tier's fate is a property of the tier
**Reported:** sold-out depot tiers vanish or lack phase-progression context.
The rust outlook already computed exactly this **and the depot cards did not read it — so a tier that had sold out but
not yet rusted said nothing at all about what was coming. That is the moment a player most needs to know: the last
3-train has left the depot, every 3-train on the board dies when the first 6 is bought, and the card was silent.**
Carried **on** the tier rather than looked up beside it, **so the card and the countdown cannot disagree about which
tier rusts when.**
Only three rust entries exist **because only three rust events exist in 1830 — Phase 2 and Phase 4 advance without
destroying anything (Phase 5 closes privates instead, which is not a rust), and Diesel is the last phase, so nothing
follows it.**

### gamePhase.ts #612 / #632 — Naming the phase, and colouring the train
**#612 — reported:** "our Phase marker probably is unhelpfully labeled … 18xx players generally refer not to 'Phase
Yellow' but 'Phase 2,' 'Phase 3,' based on which trains have been last sold."
**Correct, and the old order had the two facts exactly backwards. The PHASE NUMBER is the name of the thing — it is
what the rulebook indexes, what a player says out loud, and what every other 18xx tool displays. The tile colour is a
CONSEQUENCE of the phase, and a useful reminder, but it is not what the phase is called.**
`Phase: 3 (Green)` **reads as a name with a gloss.** `Phase: Green (3-Train)` **read as a gloss with a name buried in
it, and the "-Train" suffix made the number look like a train count rather than the phase** — the same collision
`TrainBadges.tsx` already avoided.
**The unknown branch still drops the number, per `#3`.** When no corporation has reported trains the tier falls back to
the bottom of the order rather than being measured, **and printing "Phase: 2" from that would state a fact this
function does not have. The colour survives because the board's tile colour is separately known.**
**1830 has exactly three eras** — which is why **Diesel is `Brown` and not a fourth value: the era names a tile colour
tier, and there is no diesel-coloured tile. Diesels arrive during the Brown era and do not start one.** The badge
still prints `(D-Train)` **so the distinction that DOES matter — which train is in play — is not lost.**
**#632 — instructed:** "what do you think of color-coding the trains to their color phase?" **Worth doing, and the
mapping already exists** — the tier presentation table has carried a tint since the badge needed one. **This exports
the lookup rather than letting `TrainPurchasePanel` write a second 2/3/4/5/6/D switch, which is how the depot would
come to disagree with the badge about what colour Phase 4 is.**
**The value of the coding is that it is not a new language.** Yellow, green and brown already mean tile eras on the
map, on the badge and on the hexes themselves; **a green 3-train says "this is the train that unlocks the tiles you
have been looking at" without teaching anybody anything.**
**Deliberately a separate channel from availability.** The depot marks the purchasable tier with fill and border; era
rides on the glyph. **Folding the two together — colouring only the buyable train — would make the scheme mean two
things and answer neither reliably.**
