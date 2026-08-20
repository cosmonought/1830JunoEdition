# Contract Economy — Treasuries, Trains, Privates, Auction

Money movement: treasuries, station token pricing, the depot queue and train purchase, emergency
funding and bankruptcy, private companies and their powers, and the pre-game waterfall auction.

Anchors are `<source file> #<N>`. Search the number.

---

## Station token pricing

### App.tsx #237 — What the next station token costs THIS corporation
Was a flat `SANDBOX_NOMINAL_TOKEN_COST` — $40 for every placement, forever. **1830 charges nothing
for the home token, $40 for the second and $100 for every one after**, so the constant was correct
exactly once per corporation and understated the third by 60%.

`null` means the allowance is spent. The button falls back to the second-token price for its label
in that state rather than printing "$null" — it is disabled by the placement check either way, and a
disabled control showing a plausible figure beats one showing a hole.

### App.tsx #239 — Free placements must not go through `PlaceStationToken`
`PlaceStationToken` charges the escalating price. A home station costs nothing, and routing it
through the paid message would bill a corporation for the one token 1830 gives it. The same applies
to the D&H's F16 token. Free placements finish through their own committer
(`commitFreeStationPlacement`); see `canvas_rendering.md` `#454`.

---

## Trains and the depot

### App.tsx #203 — Render the whole depot, tier by tier
`depotInventory` already applies 1830's cheapest-first queue rule and the remaining-stock arithmetic
(its `#4`), so `TrainPurchasePanel` renders it rather than deriving a second answer.

This used to be narrowed to the **one** purchasable tier before it left the shell, which is what the
old one-card tray needed. A player deciding whether to buy the depot's last 3-train needs to see what
a 4-train costs and which tier is about to rust — both facts about tiers they cannot currently buy.

### App.tsx #204 — Quantity is N messages, not a batch
`ExecuteMsg::BuyHardwareFromPool` carries no quantity field, so "buy 2" is two messages. Exactly
`handleBuyShare`'s multi-buy shape (`#42`) and for the same reasons.

**Sequential matters more here than for shares.** Buying the depot's last train of a tier advances
the phase and can rust an entire generation of trains off the board. Firing a quantity in parallel
would race that transition — the second purchase would be priced and validated against a depot the
first had not finished emptying.

`tier` is taken **for the log line only**. The contract picks the model itself (`hardware.rs` module
doc comment `#2`, "No model selection") and the panel only ever offers the tier the depot's queue is
already on, so the two cannot disagree — but naming it in the message would be inventing a parameter
the message does not have.

### App.tsx #207 — The train being run is observed, not picked  *[superseded by #227]*
This was `useState(MOCK_TRAIN_CATALOG[0].modelType)` — a 2-train, always, with a setter wired to a
tray selector `#182` had removed. So the route builder's capacity readout said "max 2 stops
(2-train)" for a corporation running a 5. The best train a corporation **owns** was the honest answer
and needed no control: `MOCK_TRAIN_CATALOG`'s order is the tier order, so the highest index a
corporation holds is its best train.

### App.tsx #227 — The player picks the train, not the app
`#207` was the right fix for the readout being wrong and the wrong **shape** for the feature: a
corporation routinely owns several trains and runs each on its own route, so "which train is this
path for" is a choice the player makes, not a fact the app can observe.

It matters mechanically — the train's number caps how many revenue centres the route may visit, so
charting a path for a 3-train while the builder validates against a 5 lets a player assemble a route
the contract will refuse.

The selection is **state**, seeded from the best train and reset whenever the acting corporation
changes. The derivation survives as the **default**, not the answer. `null` means "not chosen yet";
storing the default eagerly would make it impossible to tell a deliberate pick from a stale one after
the corporation changed.

### App.tsx #275 — The roster, not the set of models
This used to deduplicate — "two 3-trains are one CHOICE". That was right about the old question and
wrong about the game: the two buttons do **not** do the same thing once each train drafts its own
route. Three 3-trains are three trains, three routes and three chips. Ordered by tier so the roster
reads big-train-first, and carrying the **index**, because that is the only thing telling one 3-train
from another.

### App.tsx #144 (routes skip) — Disabled with the reason, not dispatched to fail
The contract refuses the Routes skip for any corporation owning a train, so the button is disabled
with the reason rather than dispatching a transaction certain to be rejected.

### App.tsx #293 / App.tsx #293b — "Owns none" is not "we were not told"
Audit G-15c closed the gap: `owned_trains` now arrives on `PublicCompanyState`.

`undefined` still means **"this chain does not say"** (a contract predating the field), **not** "owns
nothing". Two consumers read the same absence in opposite directions, deliberately:

- **Routes skip button** — report `false`, leaving the skip enabled and the contract as the
  authority. Erring the other way would disable a legal skip with no override.
- **End Turn gate** — reading "unknown" as "owns none" would lock a corporation's turn against a
  contract that never said anything: a deadlock with no override, on the one control that ends the
  turn.

The obligation only exists when the roster is **reported and empty**. **Ignorance permits**, because
the cost of a wrong "must buy" is a stuck game and the cost of a wrong "may leave" is a move the
contract will refuse on its own.

---

## Emergency funding and bankruptcy

### App.tsx #332 — The emergency, detected
`mustBuyTrain` says the corporation is **obliged** to buy. This says it cannot **afford** to, which
is the harder half and the one that costs the president their own money
(`EmergencyTrainPurchaseModal.tsx #0`).

**The price is the depot's cheapest PURCHASABLE tier**, not the cheapest printed train. 1830's depot
sells cheapest-first, so once the 2s are gone the 3-train is the cheapest thing money can buy there,
and pricing the emergency against an $80 train nobody can buy would understate the shortfall by $100.
`depotInventory` already models that queue.

`null` — rather than a plan with a zero shortfall — whenever there is no emergency, so the modal's
mount condition is one identity check and cannot disagree with this derivation about whether one
exists.

Declared beside the market table, and the placement is not cosmetic: the memo reads
`sandboxMarketPrices` to value the president's holdings, `const` bindings are not hoisted, and
`useMemo` evaluates its callback and dependency array during the render pass — so declaring it above
that table would throw a `ReferenceError` on first paint.

### App.tsx #358 — Three conditions, not one
**Reported:** the modal appears immediately in the Zero State sandbox.

`mustBuyTrain` alone is a much weaker claim than it reads as: it answers "does this corporation own
zero trains", which in a zero state is true of **all eight** before anybody has done anything. The
obligation only exists at the moment it is due:

| | |
|---|---|
| **The round** | an Operating Round. Nothing buys trains in a Stock Round or the auction. |
| **The step** | `Hardware`, the Buy Trains sub-phase. A corporation mid-track-lay is not yet obliged. |
| **The money** | treasury below the cheapest depot train — the condition that makes it an *emergency* rather than an ordinary purchase. |

The zero state fails the first two, which is why the report describes it appearing "immediately".

### App.tsx #433 — No route, no obligation
**Reported:** a floated company with no valid routes is being forced to buy a train — End Turn is
blocked and there is no way out of the turn.

`#293` built the gate and stated the rule as "a corporation that owns no train MUST buy one … There
is no branch of that rule where the turn simply ends." **That is half of 1830's rule and the half
that produces a deadlock.**

The full rule is conditional on being able to **use** the train: a corporation is obliged to buy only
if it has no trains **and** has a route it could actually run. A company whose token sits on a city
no track reaches has nothing to run. Forcing the purchase there is worse than a rules error — `#293`
deliberately keeps the button disabled even on an empty treasury, on the reasoning that the president
must pay. So a corporation with no route and a poor president had End Turn disabled, the emergency
modal demanding money for a train that could go nowhere, and no third control on the screen.

**The probe asks a hypothetical**, which is what makes it different from `maxRouteRevenue` (`#414`).
That one measures what the trains a corporation **owns** can earn and returns `null` when it owns none
— exactly the situation here. This asks instead: *if this corporation bought the cheapest train
available, could it run anything?* A 2-train is the right hypothetical because it is the smallest
thing the depot sells, so a "no" from it is a "no" for every train.

`assignRouteSet` is the same search Auto Route and the auto-withhold use. A third opinion about what
is runnable is how "the board says I can run and the button says I cannot" happens.

**Ignorance permits**, consistent with `#293b`: no tokens on the board, no map yet, or a corporation
the state does not carry all resolve to "no obligation" and leave End Turn live.

### App.tsx #333 — `EmergencyBuyHardware`, not `BuyHardwareFromPool`
They are different contract messages and the difference is the whole feature — the ordinary one
charges the treasury and floors at zero, which in this state would buy the train without anyone
paying the shortfall. The log line is written by `runGameplayAction` from the **resolved** state, so
it reports what actually moved rather than what was intended.

### App.tsx #3 (modal dismissal) — The plan IS the mount condition
`null` when there is no emergency, present for exactly as long as one is unresolved. The
`dismissedEmergencyFor` state that stood here let a player close the modal and carry on, which is the
reported bug.

*(Endgame conditions: see `state_machine.md` `#359`.)*

---

## Private companies

### App.tsx #14 — Buy Private Company action tray
A tray in the **Hardware** sub-phase alongside Buy Train / End Turn: the Phase-Gated Corporate
Purchase Protocol (`trading.rs` module doc comment `#17`) is itself a corporate treasury purchase,
the same category as buying Hardware, so it is grouped into that step rather than getting a fifth
top-level sub-phase.

The dropdown lists `playerSellablePrivateCompanies(...)` — privates the player still owns **and**
that are not `closed`, since a closed private permanently rejects the real message and is excluded
rather than offered as a guaranteed-failing option.

The price slider is bounded to the contract's own **50%–200% of face value** legal range, computed
client-side from the selected private's `cost` (floor `Math.ceil(cost / 2)`, ceiling `cost * 2`) —
purely a UX guardrail, since `trading::execute_buy_private_company` re-enforces the same bound
on-chain regardless.

The whole tray is hidden outside Phase 3+ (`current_global_era !== "Yellow"`), mirroring the
contract's own `PrivatePurchaseLockedBeforePhase3` gate, and hidden entirely if the player has
nothing left to sell. `price` is stringified for the same big-int-safety reason every other
`Uint128` field is.

### App.tsx #165 — The proposal sheet owns its own selection
`sellablePrivates`, `selectedPrivateId`, `privatePriceVgp`, their seeding effect and
`handleSelectPrivate` were all removed. They existed to drive the inline tray's dropdown-and-slider.
The proposal sheet reads the whole `private_companies` list directly so it can show privates owned by
**any** player — which is the point. `sellablePrivates` was scoped to the acting player, i.e. what
they could sell **themselves**, which is the wrong set for a corporation shopping among everyone's
holdings and is why the old tray could not express the trade it was named after.

### App.tsx #166 — The private company trade, and who actually agrees
Two pieces of client-side state: the proposal sheet's open flag and the live proposal. Both are
**local** — `ExecuteMsg::BuyPrivateCompany` is single-party and the contract never asks the seller
(`PrivateTradePanel.tsx #0`). The consequence: `proposal` is not synchronised to anything, which is
why the prompt tells the proposer that accepting buys the private outright rather than pretending a
counterparty agreed.

### App.tsx #205 — Two consent flows, one shape, different backends
A train trade and a private company purchase are the same interaction from the player's side — name a
price, the counterparty answers — and the app presents them identically. What differs is what the
chain can carry, and that decides where state lives:

- **Trains — the contract has the full flow.** `BuyTrainFromCorporation` settles instantly when one
  player presides over both corporations and otherwise **records** an offer, which
  `AcceptTrainOffer` / `RejectTrainOffer` / `RescindTrainOffer` answer and `GetTrainOffers`
  publishes. Online, the shell dispatches and the seller's client sees the offer arrive.
- **Privates — the contract has half of it.** `BuyPrivateCompany` is single-party: it reads
  `private.owner` and never asks them.

`sandboxTrainProposal` therefore exists for exactly one deployment: the offline sandbox, which has no
chain to record an offer in and no second client to show it to. Scoped to the sandbox rather than
shared with the live path so a live room can never answer a proposal the chain does not know about.

### App.tsx #662 (state shape) — Derived from shared state, not held locally
`useState` was the bug: an offer only the buyer's browser knew about, which is why the seller was
never asked and the buyer could accept on their behalf. The shape the prompt wants differs from the
shape the log carries — the prompt needs a display label for the owner and **the log must not carry
one**, because a label is this client's rendering of a wallet and two clients may resolve it
differently. So the label is added at the edge and the wallet is what travels.

### App.tsx #206 — Buying your own private needs nobody's permission
Every proposal opened the consent prompt, including the commonest transaction in the game: a
president selling a private they personally own into the corporation they run. There is exactly one
person involved and the app was asking them to agree with themselves.

This is the same fork `train_trade.rs` already draws for trains (`#205`): **one party means settle
now, two parties mean ask.**

**The comparison is against the buying corporation's president**, not the viewer's wallet. The
president is who the contract authorises for `BuyPrivateCompany`; testing the viewer would
auto-complete or prompt depending on which seat happened to be on screen, which is not a property of
the trade at all.

### App.tsx #662 (consent) — The owner answers, in every mode
**Reported:** "the decision modal appeared on P1's screen and allowed them to accept it."

This read `sandbox || ...`, defended by "sandbox is one human at one wallet, so the prompt is
answerable by whoever is looking — otherwise the only place this flow can run end to end is the one
place it cannot be tested." True when written, false since `#578` removed solo mode. A sandbox room
is several humans at several wallets, and the bypass turned "the owner must consent" into "whoever
proposed it may consent on their behalf". Same wallet comparison in both modes now, which also means
the prompt's "This is X's decision" caption is finally true on the screen that cannot act on it.

### App.tsx #444 — A private power that touches the board goes there
**Reported:** the D&H's "Place Station" button does nothing.

It did nothing in the most literal way available: the handler marked the ability spent and wrote a log
line. No dispatch, no placement, no navigation — the button reported an action it had not performed.

The hex-holding powers route through the same map flow the home station uses (`#440`). **The ability
is marked spent WHEN THE CLICK LANDS**, not when the button is pressed — a player who opens the map
and changes their mind has not used their D&H.

**The share exchanges stay as they were**, marked and logged: they touch no hex and `ExecuteMsg` has
no message for them (the whole panel is sandbox-only for that reason). Routing them to a map would be
theatre.

### App.tsx #573 / #573b — The exchanges actually exchange
They used to fall through to the mark-it-used line, which is the whole reported bug: the button
greyed out and no share arrived. **A refusal leaves the power alone** — the `return` before
`setUsedPrivateAbilities` is the entire difference between "you cannot do this yet" and "you have
spent this on nothing".

### App.tsx #331 / #327 — The privates are paid here, and only here
`sandboxSession.ts #328` explains why the reducer does not own this trigger: an Operating Round runs
one turn per floated corporation, so anything hung off a turn would pay the privates once per company
per round.

The round-transition branch is already the app's single "the round genuinely changed" edge — it fires
on a real transition compared against `prevRoundTypeRef`, not on every poll tick. That is exactly the
once-per-round guarantee the payout needs, and reusing it beats adding a second round-change detector
that could disagree.

**Sandbox only.** On a chain the contract pays the privates and the balances arrive in the next
`GetGameState`; crediting them locally as well would double every owner's income on screen until the
poll corrected it.

Reached through a ref for the same reason `logInfoRef` exists — the round-transition effect that
fires this is declared ~1300 lines above — and it reads and writes `sandboxStateRef` rather than
`sandboxState` for `#265`'s reason, since paying against a stale board would credit the wrong owners.

---

## The waterfall auction

### App.tsx #90 — A second, independent poll
`QueryMsg::GetWaterfallState`, enabled only while `gameState.current_round_type ===
"WaterfallAuction"` (`utils/gameState.ts #7`). `WaterfallAuctionDashboard` is the only consumer.

### App.tsx #261 — The auction needed to be state, not a memo
**Reported:** no Auction button does anything.

It was a `useMemo` over `(sandbox, sandboxPhase, gameId)`, so the dashboard re-rendered the same
frozen fixture after every click, and the five auction handlers dispatched into a reducer that had no
arm for the response shape they affect. **Two halves of one gap: no place to put a change, and
nothing computing one.** State now, seeded from the same fixture and advanced by
`applySandboxWaterfallAction`.

### App.tsx #311 — Passing is always legal
**Reported:** Pass Turn is greyed out for the very first player of the auction.

It was, for every player, until somebody bid. The gate read "passing is illegal until at least one
private has a standing bid" — **not an 1830 rule**, and it had the auction's own escape hatch
backwards. An opening table with no bids is exactly the position the pass rule exists **for**: if all
players decline in succession, the cheapest private is marked down $5 and the round comes back around
cheaper. Requiring a bid before anyone could pass made that markdown unreachable from the opening
position, so the first player's only legal moves were to buy Schuylkill Valley at full price or to
bid. `sandboxSession.ts`'s `WaterfallPass` branch has implemented the markdown since `#271`; this
gate was the only thing standing in front of it.

**What is still blocked, and it is a different question:** a live mini-auction. `WaterfallPass` and
`WaterfallMiniAuctionPass` are separate messages against separate cursors, and sending the former
while a contest is running advances the main seat pointer out from under the mini-auction — the same
class of cursor desync as `#310`. Dropping out of a contest is the Drop out button on the card.

### App.tsx #31 — Phase-appropriate pass
`WaterfallPass` and `PassTurn` are different contract messages, not one action with two names.
Sending the wrong one fails with an error about turn state that mentions nothing to do with passing.

### App.tsx #303 / #334 — A won private has to become an owned one
**Reported:** sold private companies disappear from the screen.

The dashboard renders a dimmed "Sold to X for $Y" card from `gameState.private_companies` filtered on
`owner !== null`. **Nothing ever set that owner.** `applySandboxWaterfallAction` **reports** the win
— it returns `won` so the caller can log it — and the waterfall's own `removePrivate` drops the
company off the live list. So the card left the auction grid and never arrived in the sold one.

The reducer reporting rather than writing is the right split (it owns the auction atom, not the game
state), so the write belongs in the shell where both are in hand. `#334`: a **list**, because one
purchase can cascade through several lone-bid privates.

The **settled** price is kept beside the state rather than written into `cost`, which is a printed
property of the company — a private won in a mini-auction went for more, and the card was previously
reduced to quoting face value with a tooltip apologising for it.

### App.tsx #337 — The all-pass payout
The reducer reports that the table passed all the way round and what the markdown cost; the money
moves in the shell, because the privates' owners and revenues live on the **game** state and the
waterfall reducer holds only the auction document. `applyPrivateRevenue` is the Operating Round's own
payout function (`#327`), reused rather than reimplemented — so "who owns it", "is it closed", "does
a corporate owner get it" and "who funds it" have exactly one answer in this app.

### App.tsx #354 — The B&O private hands its winner the presidency, free
The rule lives in `sandboxSession.ts` as a named function. `#399`: it is no longer granted at the win
— the grant needs a par price, so the win raises a prompt and the grant happens when the prompt is
answered.

### App.tsx #547 — The auction is over when there is nothing left in it
The same test the dashboard's banner used (`privates.length === 0`), moved up to where the modal is
raised. `privates` is documented as "every still-unowned core private company", so empty means all six
are allocated — there is no separate "auction finished" flag, and inventing one would be a second
opinion about a fact this list already states. **Sandbox only** (`#306`): on a live chain the contract
closes the round itself, and a client-side button offering to do it would be a lie.

### App.tsx #306 / #546 — Closing the auction goes through the dispatch path
It used to write local state directly, which advanced exactly one browser and left the others
replaying stock-round actions into an auction. Through the dispatch path it reaches the log and turns
the round over for the whole table.

### App.tsx #317 — During the auction, show AVAILABLE cash
The badge sits next to Pass and Undo on the one screen where the difference decides every action, and
a player reading $600 off the bar while $400 of it stands on a bid would be reading the one figure
they cannot spend. Outside the auction there is no escrow, so `availableCash` returns the total and
the badge is unchanged.

**App.tsx #300**: `null` when there is no seat on turn or the chain does not report it — a missing wallet must
not render as $0, which is a real and very different state.
