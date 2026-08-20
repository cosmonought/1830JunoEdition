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

---

# The Waterfall Auction Dashboard — `WaterfallAuctionDashboard.tsx`

The interactive dashboard for `waterfall.rs`'s pre-game auction, allocating 1830's six private
companies before Stock Round 1 opens. `App.tsx` renders this **in place of** the normal action bar,
board canvas and sub-panel for the entire duration of
`GameStateResponse.current_round_type === "WaterfallAuction"` (see `ContextualSubPanel.tsx`'s
`WaterfallAuctionNotice` for the short pointer it shows instead of duplicating this UI). There is no
board or stock market to look at yet, so **this component is the room's entire canvas**, not a tray
bolted onto the existing layout.

## Charter

### WaterfallAuctionDashboard.tsx #1 — Driven entirely by `QueryMsg::GetWaterfallState`
`waterfallState` is `utils/gameState.ts`'s `useWaterfallStatePolling` result, already gated by
`App.tsx` to only poll while this phase is current (`gameState.ts #7`). This component does no gating
of its own beyond a loading/error placeholder — it trusts the caller only renders it during the
auction.

### WaterfallAuctionDashboard.tsx #2 — Always all six, in the query's own ascending order
Each card shows its own live bid list, highlights the connected wallet's standing bid, and carries a
gold **LOWEST OFFER** badge on whichever `is_lowest_offered` marks — the only one `WaterfallBuyLowest`
can target and the only one that can **never** be bid on, mirroring `waterfall.rs`'s own
`CannotBidOnLowest` rejection. A private disappears from the live row once owned, mirroring
`query::query_waterfall_state`'s "still-unowned only" scope — there is no owned-private card state to
render there (see `#28`/`#30` for how sold cards are drawn from game state instead).

### WaterfallAuctionDashboard.tsx #3 — Turn gating mirrors the contract's own rejections
Mirrors `ContextualActionBar`'s `sessionReady` convention plus a **second, Waterfall-specific gate**:
every action button is also disabled unless it is the connected wallet's turn
(`waterfallState.current_turn` for the three main actions, `mini_auction.current_turn` for the two
mini-auction actions). Both because the contract itself rejects an out-of-turn call
(`NotYourTurn`/`NotYourMiniAuctionTurn`), **and** so other players get an honest "not your turn yet"
instead of a guaranteed-failing button.
`waterfall.rs`'s `PassNotAllowed` legality rule is still mirrored client-side, but by the **global**
action bar that owns the Pass button — `App.tsx` computes it from `waterfallState` and hands this
component nothing to do with passing. Pass and Undo are turn-level actions and live in the single
app-wide bar (`ContextualActionBar.tsx #31`).

### WaterfallAuctionDashboard.tsx #4 — The bid amount defaults, it does not lock
Every bid/raise input auto-fills to the live legal minimum (face value, or standing high +
`auction::MIN_BID_INCREMENT` = $5) and **re-floors itself whenever a rival bid moves that minimum
underneath it** — so a player never hand-computes the floor — but stays an ordinary editable number
input, since bidding above the minimum is always legal.

### WaterfallAuctionDashboard.tsx #5 / #6 — Mini-auction controls live in the contested card
A mini-auction pauses the **whole** waterfall for every player (`waterfall.rs` module doc #3).
Raise/Drop-out are gated by `mini_auction.current_turn`; the leader's own turn is never offered because
`waterfall::skip_leader_turns` never points `current_turn` at them, so **no client-side "you're the
leader" guard is needed.**
**#6 — one standings table per card.** The card's bid list is the only table; during a mini-auction it
gains TURN and LEADER tags rather than being shadowed by a second list of the same people.

## Auction rules made visible

### WaterfallAuctionDashboard.tsx #22 — The opening bid is face value PLUS the increment
A bid at face value would be worth exactly what the lowest-offered private can be bought outright for,
so **it offers the seller nothing and the bidder no advantage** — bidding starts one increment above.
Every subsequent bid adds another increment over the standing high, which is **the same rule applied
twice rather than two rules.**

### WaterfallAuctionDashboard.tsx #23 (status) — Bid counts map to the real cascade semantics
Grounded directly in `waterfall.rs`'s cascade semantics (module doc #3), not fabricated: **0 bids**
leaves a private simply open; **exactly 1 bid** is what the next cascade run auto-resolves to that sole
bidder ("auto-award"); **2 or more** is what starts — or, if already running, *is* — a mini-auction.

### WaterfallAuctionDashboard.tsx #14 (action selection) — Each card offers exactly one thing
Mirrors `waterfall.rs`'s legality rules rather than inventing a scheme: the lowest-offered private is
the only one `WaterfallBuyLowest` can target and the only one that can never be bid on; every other
still-unowned private takes bids at face value or +$5 over the standing high. **So each card offers one
of three things, and never a choice between them.**

### WaterfallAuctionDashboard.tsx #315 — The affordability gate
Both money gates are computed in one expression so the button's `disabled` and its tooltip are driven
by the same thing — a control that is off for a reason it does not state is the shape this codebase has
removed repeatedly.

**The RAISE case subtracts the bid this player already has standing in this contest.** That money is
escrowed against this very private, so a raise only has to fund the **increment**; charging the full new
figure against available cash would stop a player defending a bid they have already paid for, which gets
the position exactly backwards.
**Buying outright is gated on AVAILABLE cash, not the total.** A player's escrow elsewhere is refundable
in principle but is not refunded **yet** — the note is under another certificate and cannot also be
handed over for this one. `WaterfallBuyLowest` settles immediately, so available is the only figure that
can honestly fund it.

### WaterfallAuctionDashboard.tsx #384 — One bid per private, in the waterfall proper
**Reported:** players can spam bids on the same private before a mini-auction.
They could, and each one escrowed more cash against the same certificate. `ownRaiseEscrow` is the
evidence: it **sums** a seat's bids on one private, and it only needs to sum because a seat could have
several. A second bid on a private you are already standing bidder on is **a player bidding against
themselves**; a second bid behind someone else's is the move that should be a **raise**, and raising is
what the mini-auction exists for.

**So the gate is "have I bid here", not "am I winning here"** — both cases are the same mistake and both
are refused with the same sentence.
**The mini-auction lifts it, which is the whole point of the exception.** Once a contest is triggered the
control is Raise rather than Place Bid, and raising repeatedly is how the contest is fought — with
`ownRaiseEscrow` doing its real job of charging only the increment. Gating that would make a triggered
auction unwinnable by whoever opened it.
`ownRaiseEscrow > 0` is the test rather than a separate scan of `priv.bids`, because it already **is**
"this seat's money standing on this private" — deriving the same fact twice is how two answers start to
disagree.
**The FIELD goes too, not just the button.** A live input above a dead button invites the player to type
a figure and then discover it cannot be sent, which is a worse refusal than one that never took the
keystrokes.

### WaterfallAuctionDashboard.tsx #314 — Whose money the controls are about to spend
The Available Cash figure and the bid gates must agree on **one seat**, and which seat differs by mode.
**Online** it is always the connected wallet — a player watching somebody else's turn still wants to see
what *they* can afford, and the controls are disabled anyway.
**Hotseat has no wallet**, so the only seat the controls could act for is the one on turn — and during a
mini-auction that is the **mini-auction's cursor**, not the main one. Getting this wrong is not
cosmetic: it would gate Alice's raise against Bob's balance.

### WaterfallAuctionDashboard.tsx #30 — Hotseat has no wallet to compare against
**Reported:** the Auction round is completely non-interactive in Sandbox.
Every control was gated on `current_turn === connectedWalletAddress` — correct online, where "is this my
turn" means "is the seat on turn the one I signed in as". The sandbox has no wallet, so the comparison is
false for every seat and the whole screen renders as somebody else's turn forever.

Pass-and-play asks a **different question**: not "is this seat mine" but "is anyone at this keyboard
allowed to act for the seat on turn". In hotseat the answer is always yes — **that is what pass-and-play
is.**
**A separate flag rather than a fake address.** The tempting shortcut is handing the sandbox
`connectedWalletAddress = current_turn` and letting the existing comparison pass. That would also make
every "YOU" badge and own-bid highlight follow the turn around the table — exactly the confusion
requirement 1 is about. **`hotseat` unlocks the CONTROLS and leaves the identity comparisons alone.**

### WaterfallAuctionDashboard.tsx #306 — "Is concluding" is not a state a player can leave
With every private allocated the grid said "the Waterfall Auction is concluding" and offered nothing.
That is a progress message for a process the player is waiting on — **but nothing was in progress**: the
auction was over and the round needed advancing, which is an action somebody has to take.
So the message states what happens next and the button does it. **Omitted (`undefined`) leaves the
message without a control**, which is the right shape on a live chain where the contract advances the
round itself and a client-side button would be a lie. The control is full width and green: it is the only
thing to do on that screen, and a quiet control in that position reads as decoration.

## Identity and seats

### WaterfallAuctionDashboard.tsx #31 — The sandbox seats were distinct and looked identical
**Reported:** players and turn order all display as a generic `juno…00` address instead of Alice, Bob,
Carol.
**The addresses were never the problem** — `SANDBOX_PLAYERS` holds four genuinely different strings and
`sandboxPlayerLabel` maps them to names. **What collapsed them was TRUNCATION**: all four are the same
literal prefix padded to the same length with zeros, so `truncate` takes the same 8 from the front and the
same 4 from the back of every one and returns the identical string four times.

`playerLabel` was already threaded into this component — and used in exactly one place, the sold-private
owner. The turn banner, the seating list, the bid rows and the mini-auction lines all called `truncate`
directly, **which is why the screen the player actually reads was the one showing four identical
addresses.**
`nameFor` is now the only way an address reaches the DOM here. It falls through to truncation for a real
wallet, which is right there — a live game has no name table and 8/5 of a real address **is**
distinguishing.

### WaterfallAuctionDashboard.tsx #604 — The player cards arrive as a node
The same conduit shape `ContextualActionBar` uses for `seatOrderTrail`, and for the same reason: this
dashboard has no business knowing how a player card is built, what finances feed it, or which round it
belongs to. **It knows only WHERE on the auction screen the players go**, which is the one fact `App.tsx`
cannot state from outside.
Passing the built element rather than the data also keeps the Stock Round and the auction rendering **one
component instance shape** — `#602` hoisted it to a single definition precisely so the two surfaces could
not drift, and re-deriving it from props here would hand that back. `undefined` renders nothing, which is
what a caller with no cards to show should be able to say without a second flag.
`ownedPrivatesFor` went with the seating table it fed (`#593`): the player cards list a seat's privates
from `playerFinances`, which reads the same state and is now the only place computing it.

## Layout

### WaterfallAuctionDashboard.tsx #11 — Stacked, not side by side
`body` used to be a row, with the six private cards squeezed into whatever width a fixed 300px action rail
left over. Two problems, and **the second is the one that mattered**: at six columns the cards were far too
narrow to read, and the rail sat immediately beside them, so "Your Turn Actions" and "Seating Order" read
as if they belonged to whichever card they happened to be level with. **The auction has one shared action
rail for all six privates, and the layout was implying six.**
Now the privates own the full width at the top and every interactive surface lives in one clearly
separated band underneath — the heavy top border and recessed background are doing real work, stating that
this area serves all six cards above. The grid reflows from six across to three or two as the window
narrows; a hard six-column grid was unreadable below about 1500px.

### WaterfallAuctionDashboard.tsx #14 → #17 — Flat actions, no accordion
Two shapes were tried before this and both were wrong in opposite directions.
**A shared bid tray at the bottom (`#11`)** made the six cards a read-only display: you picked a company by
name in a dropdown, then typed a number somewhere else, with nothing connecting the two but your own
attention.
**Making each card an accordion (`#14`)** fixed that ambiguity and introduced a worse one — a click to open
before any action, on a screen where there are only six cards and **every one has exactly ONE legal
action.** An accordion earns its keep when the hidden content is large or rarely wanted; here it hid a
single button behind a click, six times over, on the screen a player uses most rapidly.
So the action lives on the card face: Buy (lowest-offered), or Place Bid with its input, or Raise and
Drop-out for a card under a live mini-auction. **Nothing is hidden and nothing needs opening.**

### WaterfallAuctionDashboard.tsx #30 (ordering) — One ordered grid, sold cards in place
Sold privates were appended **after** the live ones, which pushed them to the end of the grid — so winning
the cheapest private visually moved it to the far right, past companies worth ten times as much. **The
waterfall's whole structure is its ascending face-value order**; a card that jumps position on being sold
destroys the one thing the layout communicates. Live and sold are merged and sorted by face value, so every
card holds its slot for the entire auction and simply greys out when won.

### WaterfallAuctionDashboard.tsx #20 / #21 — The buttons form a line, and the bid table must not grow the card
**#20:** `marginTop: auto` in a full-height flex column pushes the action block to the card's bottom edge,
so the six buttons align horizontally instead of floating wherever each private's special-power text
happens to end — descriptions run from one to three lines, which previously put the buttons at six
different heights.
**#21:** up to six players can bid on one private, and the table sits between fixed content above and the
bottom-anchored action block below. Left unbounded, a six-bidder table pushes the card past its siblings'
height — and **because the grid rows stretch, ONE contested company would inflate every card in its row**,
dragging the action buttons out of alignment. Capped and scrolled at ~3.5 rows instead: enough to see the
leader plus the chase, and enough of a cut-off edge to show there is more. `flexShrink: 0` on the action
block keeps the buttons anchored rather than compressed by a full table.

### WaterfallAuctionDashboard.tsx #23 (scroll) — Auto-scroll to the turn player
The capped table created a new way to miss the thing that matters: with six bidders, whoever is on turn is
as likely as not below the fold — and during a mini-auction that row is the only one anyone is waiting on.
**`scrollTop` is set directly rather than `scrollIntoView()`.** The latter scrolls every scrollable
**ancestor**, so a row near the bottom of a card would also jog the whole page — which on a six-card grid
means the board jumps whenever the turn passes. Setting `scrollTop` on the container moves exactly one
scroller.
`offsetTop` is measured relative to the scroll container because the container is the row's `offsetParent`
(it is `position: relative`), so the subtraction is what pins the row to the **top** of the window rather
than merely somewhere inside it.

## Card treatment

### WaterfallAuctionDashboard.tsx #12 / #18 — Certificates, one fill, state at the edges
**#12:** the old `#1b1f29` on the panel's own `#161922` was a four-point lightness difference — effectively
invisible, so the six privates read as one undifferentiated block of text rather than six things you choose
between. **These are the objects being auctioned and they should look like objects.** The treatment is a
warm parchment-toned slate with a gold left edge — a stock-certificate cue, and deliberately the only warm
surface on an otherwise cold blue-grey screen.
**#18 — one fill.** All three variants share `CARD_SURFACE`. They previously had three different
near-whites — plain, a warmer lowest-offer, a pink mini-auction — which together with the Stock Round's two
more made **five almost-but-not-quite-matching paper tones across two screens**. The effect was not
"colour-coded", it was "inconsistently grubby". State is now carried entirely by the border, the left
accent stripe and the badges, **which is enough signal precisely because the fill is constant**: a gold
edge reads as gold against identical paper, where before it competed with a gold-tinted fill. The shared
value lives in `styles/palette.ts` rather than being typed twice.

### WaterfallAuctionDashboard.tsx #38 — The lowest-offered card's border is neutral
It briefly wore the gold active border and a matching glow, and adding a green Buy button and green badge
on top made **one card carry three competing emphases at once** — the tile shouted before the player had
read what it was. The green now does the whole job, confined to the two elements a player acts on: the
LOWEST OFFER badge says which card, the Buy button says what you can do. **The card underneath them is
plain, which is what lets them read.**

### WaterfallAuctionDashboard.tsx #29 / #302 / #422 — Competing bids, the leader, and the turn
**#29 — orange.** Competing bids and a live mini-auction are different states: one is "this will need
resolving", the other is "this is being resolved right now, and the whole waterfall is paused on it". Both
were red, which flattened the distinction; **red is now reserved for the live one.**
**#302 — the leader is red, per the brief.** It marks the player everyone else must outbid — an alarm for
the other bidders rather than a decoration for the leader.
**#422 — prominent, and no longer shouting.** `ON TURN` was tracked-out uppercase because it was a status
tag at the end of a row; **"Your turn" is a sentence fragment addressed to the reader**, so it drops the
letter-spacing and keeps the high-contrast green fill that made it findable.

### WaterfallAuctionDashboard.tsx #319 / #321 — Cursors and glyphs that stopped meaning anything
**#319:** `cursor: pointer` came off with the accordion, five notes late. It was the last trace of a control
that no longer exists — the block is a `<div>` with no `onClick`, so the hand cursor promised a click that
does nothing, and **on a screen of six cards where the real actions are buttons an inch below, a player who
tries it learns to distrust the cursor everywhere else.**
**#321 — standalone glyph, no plate.** A pill around a single character reads as a badge that has lost its
label; the star carries itself. Sized a step above body text so it is findable down a column, with a soft
gold shadow so it holds against the card's surface without a background.

### WaterfallAuctionDashboard.tsx #32 / #320 / #344 — The mini-auction chaser
**#32:** inline `React.CSSProperties` cannot express `@keyframes`, so this follows `App.tsx`'s existing
injected-`<style>`-tag convention.

**#320 — an event, not an emergency.** *Reported:* the mini-auction card's border glow should be an
animated multicolour chaser rather than a warning hue. The old ring pulsed **red, and red on this screen
already means something else** — the critical phase badge, the rust chips and every disabled-reason tooltip
use the warning palette for things going wrong. A mini-auction is the most interesting thing that can
happen in the auction and nothing is wrong at all.
**How it is built:** two background layers on one element — an opaque fill clipped to the **padding** box,
and the gradient clipped to the **border** box. The fill covers the middle, so the only gradient visible is
the 3px ring: a real animated border with no pseudo-element and no stacking-context tricks.
**Why not a rotating `conic-gradient` on a `::before`** (the usual recipe): a rotating rectangle does not
cover its own bounding box at the corners, so the ring tears diagonally four times per turn unless the
layer is oversized into a square and re-centred. `background-position` on a repeating linear gradient has no
such geometry, animates a property every engine interpolates, and needs no `@property` registration.
**The palette runs the full hue circle** rather than a two- or three-stop blend: the point is that it is
unmistakably **not** any of the status colours this UI already assigns meaning to.
**Reduced motion keeps `#26`'s bargain** — the ring stays, in a static multicolour. A cue that cannot be
switched off is an accessibility problem; **a cue that DISAPPEARS when motion is reduced is an information
problem**, and turning the animation off must not cost the player the answer to "which card is live".

**#344 — the chaser had a dark gap every cycle.** *Reported:* it pulses briefly, goes dark and restarts.
The animation was right; **the tiling was not.** The gradient layer carried `background-repeat: no-repeat`,
so as the keyframes translated it the single painted tile slid off the border and left bare transparent
border behind it. **Two conditions make it seamless, and both must hold:**

1. **The tile repeats** — `background-repeat: no-repeat, repeat`: the opaque fill must NOT repeat (it is
   sized to the box), the gradient must, so there is always another copy arriving behind the one leaving.
2. **One cycle moves exactly one tile.** A percentage in `background-position` is a fraction of
   *(positioning area − image width)*, **not** of the area — so with `background-size: 200%` the image is
   2W wide, the base is `W − 2W = −W`, and `200%` resolves to `−2W`. The tile is 2W. One tile exactly, and
   the W cancels, so it holds at every card width. **Change the 200% in `background-size` without changing
   the 200% in the keyframe and the loop visibly stutters once per cycle.**

The palette's first and last stops are the **same colour** for the same reason: the tile has to butt
against its own copy without a seam.

## Sold privates

### WaterfallAuctionDashboard.tsx #28 / #30 — A won private holds its slot and greys out
Fed from `GameStateResponse.private_companies`, **not** `GetWaterfallState.privates`, which only reports
still-unowned companies.
**⚠ The price shown is FACE VALUE, not the winning bid.** `PrivateCompanyState` exposes `cost` and `owner`
and nothing else — **the settled price is not in any query response**, so a private won in a mini-auction
displays less than was actually paid. Exposing it is a backend change; the tooltip says so.

### WaterfallAuctionDashboard.tsx #340 — Winning a company should not erase it
**Reported:** sold private companies lose all their information — powers, text — keeping only the name and
face value.
They did. The sold card rendered a header, one figure and the sold badge, while the live card beside it
rendered the same header, **two** figures (face value and revenue per OR) and the special-power block. So
the moment a player won a company, the description of what they had just bought disappeared.

**That is exactly backwards.** Before the sale the ability text is *shopping information*; after it, it is
the owner's **reference** — the thing they consult when deciding whether they can lay a free tile this turn,
or what their income is. The auction grid stays on screen for the whole auction and sold cards hold their
slots (`#30`), so this was six cards progressively turning into blanks.
The catalog lookup is by `private_id`, **the same key the live card uses**, so there is one source for the
text and no chance of the two cards describing the same company differently.

---

# Operating Round economics on the bar — `ContextualActionBar.tsx`

The dividend, train-purchase and private-company rules as the action bar enforces and explains them.
Layout and shell notes for the same file live in [ui_shell_layout.md](ui_shell_layout.md).

## Dividends

### ContextualActionBar.tsx #278 — A corporation that earned cannot decline
Skip was available on the Dividends step regardless of what the trains had earned, which offers a
**third option 1830 does not have.** Once a corporation runs a route for more than $0 the money
**exists**, and the rules give exactly two places it can go: out to the shareholders, or into the
treasury. There is no third door where it evaporates.
Worse than merely wrong, **it was the one step where skipping silently destroyed value.** Skipping
Track or Tokens forgoes an opportunity; skipping a declared $180 would have thrown away $180 the
corporation had already earned, and nothing on screen said so.
This tests the **revenue** rather than the sub-phase: the question is whether anything was earned, not
which step the cursor is on. `#278` also sets `dividendRevenueIsThisTurn` false for a corporation that
skipped Routes, so a stale `last_route_revenue` cannot be paid out.
*(Its own "IT STAYS AT $0" exception is superseded — see `#436`.)*

### ContextualActionBar.tsx #414 — There is no such thing as paying $0
**Reported:** a corporation with no earnable revenue is still offered "Pay Dividends", quoting $0 per
share.
**1830 has no such declaration.** A corporation that earned nothing **withholds** — that is the whole
decision, and it is the one that steps the share price left. Offering Pay beside Withhold at $0
presents a binary where the rules have a single outcome, and the two buttons do not even differ in
effect: paying nothing and withholding nothing move the same zero. **The only thing the player could
get wrong is the market move, and Pay gets it wrong silently** — the marker stays put, the price never
falls, and nothing says a rule was skipped.
So at zero the choice collapses to the one legal action. `App.tsx #414`'s forced-withhold effect will
normally have declared it before this renders; **this is the same rule expressed on the control**, so a
player who reaches the step during the poll interval preceding the auto-declaration cannot click the
button that should not exist.
**The test is the revenue, not the train.** `dividendRevenue` is already what Pay spends and what its
per-share figure divides, so gating on it cannot disagree with the label beside it — and it covers the
stranded-train case, the trainless case and the ran-a-worthless-route case without naming any of them.

### ContextualActionBar.tsx #436 — $0 is a decision too, and Skip is not it
**Reported:** at $0 route revenue, hide Skip and offer only Withhold.
`#278`'s own text argued the exception: "a corporation that ran nothing has no money to allocate…
`DeclareDividends` for zero is a message with no effect, so Skip is the honest control there."
**The premise is wrong, and `#414` had already established why one step over: a $0 declaration is NOT a
message with no effect. It is the withhold that steps the share price one cell LEFT** — the single most
consequential thing that happens to a corporation that could not run. Skip dispatches
`AdvanceOperatingSubPhase`: it moves the cursor and settles nothing. So at $0 the two controls did
visibly similar things and only one obeyed the rules.
Worse, **Skip was the more prominent of the pair by position**, so the easiest action on the screen was
the one that silently omitted a mandatory market move. That is how a corporation's price stays put
through a round it should have fallen in.

### ContextualActionBar.tsx #485 — Skip is never a dividend declaration
**Reported:** a corporation landing on Dividends with $0 revenue must not be offered Skip — only
"Withhold $0".
`dividendRevenueIsThisTurn` was the third clause of the gate, and **it is false in precisely the
situation the report is about**: a corporation that skipped Routes (`#278` sets it that way so a stale
`last_route_revenue` cannot be paid out). **So the one corporation guaranteed to have $0 was the one the
Skip button was kept alive for.**
The clause is **gone rather than inverted**, because there is no state of an Operating Round in which
Skip is the right control here. 1830 requires a declaration every turn: revenue splits or it is
withheld, and $0 withheld is what steps the marker left. Skip remains correct on Track, Tokens and
Routes, all of which are genuinely declinable. **This is the one step that is not.**

### ContextualActionBar.tsx #485a — One revenue figure, four surfaces
`dividendRevenue` is the corporation's `last_route_revenue`, which is a **previous turn's** figure for a
corporation that skipped Routes — `#278` established that and used it to hide the Pay button, then left
the number itself in circulation.
Four surfaces quote it: the Pay label, the Pay tooltip, the Withhold label/tooltip, and the consequence
panel's "Pay out $N · $M/share" heading. **Three were quoting the stale one**, so a corporation that ran
nothing displayed a payout table for a run that did not happen. Derived once, above every reader, through
the same `dividendDeclaration` `App.tsx` uses for the dispatch (`App.tsx #486`) — **so the number on the
button and the number in the message are one derivation rather than two that agree today.**

### ContextualActionBar.tsx #188 / #490 / #509 — The consequence belongs to the button
**#188 (kept):** the consequence of each option, laid out before the player commits — **who** gets paid
and how much, and **where** the stock token lands. Both are computable from state already on screen and
both were previously left for the player to work out.
**#490 — reported:** the Dividends step opens a separate, redundant panel below the Action panel.
It did, and **the split was structural rather than cosmetic**: the block sat *outside* the bar's own root
`<div>`, as a sibling, so a bordered card appeared under the bar when the sub-phase changed and vanished
when it advanced. **The player read the payout in one panel and clicked the button that caused it in
another, with a border between the cause and the effect.** Only its address changed: it renders inside
`orPanel`, directly beneath the row carrying Pay and Withhold, so each column sits under the button it
describes. (`orPanel` is a flex column, so the move needed no new layout — only a different parent.)
**#509 — reported:** the Dividends block must stay visible and travel with the pinned panel.
`#490` gated it on `!condensed`, reasoning from `#298`'s "keep what a player needs while looking at the
board". **That rule is right and this was the wrong side of it**: the payout table and the two market
moves are not orientation, **they are the INPUTS to the two buttons directly above them.** Hiding them
when pinned left a player scrolled down the page with Pay and Withhold live and no way to see what
either does. The Buy Trains panel travels for the same reason and by the same mechanism — the bar is
`position: sticky`, so anything inside it follows.

### ContextualActionBar.tsx #509a — Show the money moving, do not describe it
**Reported:** replace the explanatory string under Withhold with the corporation's herald and a strict
`[current treasury] ➔ [new treasury]`.
The sentence it replaces — "The full amount stays in the corporation's treasury. Shareholders receive
nothing this Operating Round." — was two clauses of rules text on a panel whose other column shows an
actual table of figures. **It described a consequence the player then had to compute:** they know the
treasury and they know the revenue, and the panel made them add.
It **mirrors `MarketMoveLine` deliberately** — same arrow, same green-for-a-rise rule (`#489`) — so the
two things a withhold does, move the treasury up and the share price left, read as one pair of
before/after facts rather than as a paragraph and a diagram.
**The herald is the subject.** Whose treasury this is was the one fact the sentence carried that the
numbers do not, and a logo says it in the space a pronoun took.
The dividend panel sits on the bar's own dark surface rather than the corporation's livery, so the
logo's **text fallback takes the panel ink** — not `bestContrastTextColor`, which answers a different
question (what is legible *on* the brand colour).

## Trains

### ContextualActionBar.tsx #293 — A corporation must own a train
**Reported:** a corporation with no trains can click End Turn in the Buy Trains step without buying one.
**1830 does not let it.** A corporation that owns no train MUST buy one, and if its treasury cannot cover
the cheapest in the depot **the president pays the difference personally** — the emergency purchase.
There is no branch of that rule where the turn simply ends.
**The poverty case is the one that matters**, and it is why this is not merely disabled when the
corporation could afford a train: being unable to pay is precisely when a player wants the exit, and
precisely when 1830 refuses it — **the obligation falls to the president rather than lapsing.** So the
button stays disabled on an empty treasury too, and the tooltip names the president's purchase rather
than implying the step is stuck.
**The gate is "owns a train", not "has bought one this turn"** — a corporation that acquired one by trade
has satisfied the rule just as completely.

### ContextualActionBar.tsx #619 — Say the obligation, do not only refuse it
The other half of the report: "the 'End Turn' button needs to be grayed out AND/OR prompt errant clicks
that they must buy a train."
**A `disabled` button cannot answer a click** — the browser swallows the event before any handler runs —
so "prompt errant clicks" is not available without un-disabling the control and refusing the action
ourselves, **which would put a button on screen that dispatches nothing.** The honest substitute is to
stop the click being errant in the first place: state the obligation where the player is already looking,
in the step that owns it.
So the notice is **persistent rather than a response**. It appears with the panel, above the depot the
player is about to buy from, and it names the emergency purchase — **which is what makes the greyed
button feel like a rule rather than a malfunction**, because the poverty case is exactly when a player
reaches for the exit.

### ContextualActionBar.tsx #203 / #508 — One purchase component, at a new address
**#203:** `#182` correctly reduced a six-card selector to the ONE train 1830's cheapest-first depot will
actually sell. What it could not fix, sitting inside the bar, is that **the depot was only half the
step**: a corporation in the Hardware sub-phase can buy from the bank **or** from another corporation,
and the second half lived in a separate panel further down the page. Both halves became
`TrainPurchasePanel`. The bar keeps only "End Turn" for this step — the one thing here that is a button
rather than a panel.
**#508 — reported:** the train purchasing interface should condense and travel with the pinned panel.
`#203` was correct to move it out, but what that left was **a step whose entire interface lived below a
`position: sticky` bar** — scrolling the board scrolled the controls away and left "End Turn" pinned on
its own. `#491` patched the symptom with a jump button; this removes the cause by rendering the panel
**inside** the bar, sticky by inheritance, with nothing to jump to.
**It is still one component**, which keeps `#203`'s argument intact — there is exactly one place a train
is bought, it has simply changed address. `condensed` is the panel's own pinned form, not a second
cut-down copy.
**The props travel as ONE object, deliberately.** These are not facts the bar reasons about — it neither
reads nor derives any of them — they are a child's props passing through. Spreading them across the bar's
own interface would put eight train-shaped fields next to the round type and the sub-phase, **implying
the bar has an opinion about the depot.** `null` outside the step renders nothing.

### ContextualActionBar.tsx #142 / #266 — Running trains is its own phase
Running trains is what **produces** the revenue figure; the dividend decision is what is done with it.
**No contextual button.** "Run Selected Route" used to sit in the centre column, *above* the panel showing
the route it would submit and the readout saying whether that route was legal. It is now the bottom row
of `RoutePlannerPanel`, directly under the path it runs and carrying the amount it pays. **Leaving a copy
here would be a second control for one action — and the vaguer of the two, since only the panel's copy
knows the figure.**

### ContextualActionBar.tsx #248 / #259 / #372 — The train limit, and the rust countdown
**#248:** the limit sits beside the fleet it caps. The chips say *which* trains; this says how much room
is left, which is the figure that decides whether the Buy Trains step has anything in it. Amber at the
ceiling, because that is the state that ends the step.
**#259 — the rust countdown**, matching the Round Detail table below the board. Without `outlook` a
chip's tooltip names **what** will destroy it but not **how soon** — and "rusts when the first 4-train is
bought" is a different decision from "rusts in one more purchase". The figure was already computed for
the table; the bar simply was not being handed it.
**`gamePhase.ts #7` — two steps, not one.** The phase-shift badge used to render identically at two
purchases and at one, so **the last purchase before a rust — the single most consequential moment in an
1830 game — looked exactly like the moment before it.** It now reads the same `phaseAlertLevel` helper
the train chips do, so the bar and the chips escalate together, and the wording escalates with the
colour: "Imminent" is a claim about the *next* purchase, and it was being made one purchase too early.

## Stations and privates

### ContextualActionBar.tsx #237 — Tokens, not a fraction
This read `2/4 — $40 ea`, which was **wrong about the money** and shaped wrong for the decision. The
price is not flat: **the home token is free, the second is $40 and every one after that is $100**
(`utils/stationTokens.ts #0`), so "$40 ea" understated a third token by 60%.
The row draws the corporation's whole allowance as circles in placement order, each captioned with its
own cost, spent ones greyed in place. See `StationTokenRow.tsx` for why it needs its own inset surface on
a brand-coloured bar.

### ContextualActionBar.tsx #379 (strip half) — Privates the company owns
A corporation that bought a private from a player owns a real asset — **it pays that company's revenue
into this treasury every Operating Round** (`#329`) — and no surface said so. `utils/gameState.ts #379`
has the full account.
**Absent, not empty, when there are none.** Most corporations never buy a private, so a permanent
"Privates: none" on the one bar that is on screen all turn would be a row of nothing for seven companies
out of eight. The Game Ledger's table shows a dash instead, **which is right for a table — a column has
to keep its cell — and wrong for a strip.**

### ContextualActionBar.tsx #165 — The inline Buy-Private tray is gone
It was a select, a range slider and a Buy button wedged into the bar, and **it modelled the purchase as a
UNILATERAL act**: pick a private, drag a price, buy it. In 1830 that transaction needs the owner's
agreement, and **a slider you drag past somebody else's property does not represent one.**
`ProposePrivatePurchase` replaces it — a real sheet with the eligible privates, each showing its owner and
its legal band, and a **typed** price rather than a drag. Typing matters: the band is **50–200% of face
value**, so a $100 private has a 51-value range and a slider makes hitting an exact figure fiddly.
The tray also sat under the **Hardware** sub-phase, which is wrong — **`trading.rs`'s own sub-phase gate
puts private purchase FIRST in the turn, before track.** The button now lives in the `BuyPrivate` step
where the contract expects it.

### ContextualActionBar.tsx #441 — A corporate power belongs to the corporation operating
…and is executed by whoever holds its controls. The bar already resolves both — `activeCorporation` is the
acting company and `presidentAddress` the person entitled to act for it — **so the panel is handed the
same answers the rest of the bar is gated on rather than deriving a second set.**

### ContextualActionBar.tsx #10 (item 2) / marketplace tray — Phase 4 selection is cosmetic
Within an Operating Round the button set swaps per `orSubPhase`, walking the player through a
corporation's turn in the real 1830 legal order — **Track → Tokens → Dividends → Hardware** — one step at
a time, rather than exposing every OR action at once. See `#8` for exactly which real `ExecuteMsg` each
button dispatches, and why "Place Station Token" is deliberately non-dispatching.
**Honest limitation on the Phase 4 marketplace tray:** `BuyHardwareFromPool` has no per-model parameter
yet (see `MOCK_TRAIN_CATALOG`'s doc comment), so selecting a card **only changes which model is
highlighted/labelled** — the purchase still targets whichever unit the pool auto-assigns.

## Money, by pocket

### ContextualActionBar.tsx #300 — The player's own money was nowhere on this panel
The bar reports the **corporation's** treasury, which is what pays for track, tokens and trains — and said
nothing about the player's own cash, which is what pays for shares, private companies, and the president's
emergency train purchase this app now enforces (`#293`). **Those are different pockets and both are spent
from this screen.** A president told "you must buy a train" with no way to see whether they can personally
cover it is being asked a question the UI is refusing to answer.

### ContextualActionBar.tsx #325 / #326 — Two pockets, one row, constant confusion
**Reported:** the standalone personal cash line in the Operating Round panel is confused with corporate
treasury funds.
`#300`'s reasoning is true and the placement was still wrong: **this rail sits directly under the
corporation strip, which shows `Treasury $X` in the same typeface at the same size.** Two dollar figures,
one above the other, both attached to the acting turn — and the tooltip explaining that they are different
pockets **only opens if you already suspected they were.** An Operating Round spends the CORPORATION's
money; nothing on this rail is charged to a player's wallet, so the figure had no decision on this screen
to inform.
**#326 — it is not deleted, it is moved**, hanging off the president's own **name** in the strip above,
where it is unambiguously a fact about the person rather than about the turn. **A number beside a crown is
a fact about that human**, where the same number floating in the rail below was a fact about "the acting
turn", which in an Operating Round means the company.
**A tooltip rather than visible text** because it is reference, not a driver: it answers "can they cover
the emergency buy" when somebody asks, and the rest of the time the strip is about the corporation. **The
dotted underline is what makes it discoverable — an unmarked tooltip is one nobody hovers.**

### ContextualActionBar.tsx #308 — The auction bar had neither name nor money
`#300` put the acting player's cash on the Operating Round branch. The auction and Stock Round take the
**other** branch and got neither — **which is the wrong way round if anything**: an Operating Round spends
the corporation's treasury, while a private auction spends the player's own money and nothing else. **The
one screen where a personal balance decides every action was the one not showing it.** It leads the row
rather than trailing it, because in a hotseat the first question on arriving at the bar is whose turn this
is.

---

### WaterfallAuctionDashboard.tsx #312 — Two privates cannot reserve one hex
*(The note lives with the catalog text it corrects, in `utils/privateCatalog.ts`; anchored here because
`utils/privateReservations.ts` and `utils/sandboxState.ts` both cite it by number.)*

An older set of paraphrases had **D&H naming B20 — C&SL's hex — and M&H claiming F16, which is D&H's.**
The catalog descriptions settle it by construction: **C&SL is B-20, D&H is F-16, and M&H reserves nothing
at all** because its power is the NYC exchange. (Schuylkill Valley canonically has no power, and its line
says so outright rather than leaving a blank that reads as missing data.)

**⚠ The divergence it recorded is still live and still belongs on the contract audit list:** `auction.rs`
gives Mohawk & Hudson a reserved hex of **F16**. On this board F16 is Scranton and Scranton is the D&H's.
Nothing in the frontend reads the reserved hex to make a decision, **so the divergence is cosmetic until
the contract starts enforcing it — and fixing it properly means changing `auction.rs`, not editing the
display text.**

## Short notes and cross-references — `WaterfallAuctionDashboard.tsx`

### WaterfallAuctionDashboard.tsx #13 — No enforcement badge on a special power
All six privates' powers are displayed as text; none carries a badge claiming the frontend enforces it.
The powers are contract behaviour, and a badge would assert an enforcement this UI does not perform.

### WaterfallAuctionDashboard.tsx #19 — One standings table per card
This card used to render **two**: a "standing bids" list, and a second "mini-auction bidders" list
inside the action area listing **the same people** with different columns, a few pixels apart. **The
obvious question is which one is current, and there was no answer because both were.** There is now one
table; during a mini-auction it gains TURN and LEADER tags rather than being duplicated by a table that
has them. Each row is name + tags left, amount right.

### WaterfallAuctionDashboard.tsx #27 — Input, Raise and Drop Out on one line
They were three stacked blocks with a hint between them, which read as three unrelated decisions and
cost four rows in a card that has to fit six across. **They are one decision — how much, or not at all**
— so they sit on one row with the minimum folded into the line above.

### WaterfallAuctionDashboard.tsx #303 — What each private actually sold for
See `App.tsx #303`: the settled price by private, which `GetWaterfallState` does not report (compare
`#28`, where the sold card can only show face value).

### WaterfallAuctionDashboard.tsx #304 — The printed number
1830's privates are known by order as much as by name — **"the 3" is how players refer to the Delaware
& Hudson — and the waterfall IS that order**, so the grid was showing a sequence with its index filed
off.

### WaterfallAuctionDashboard.tsx #305 — One line, not three saying the same thing
The header was a title, a subtitle and a hint: three restatements of the same fact stacked above the one
piece of live information in the row. **A player reads a header once**, and everything above the pass
count told them where they already knew they were, at a cost of three lines at the top of the screen.

### WaterfallAuctionDashboard.tsx #308 — The acting player, named and funded
See `ContextualActionBar.tsx #308`: the auction bar had neither a name nor a balance, on the one screen
where a personal balance decides every action.

### WaterfallAuctionDashboard.tsx #322 — One answer to "whose turn is it"
The standalone Turn panel in the footer had become redundant **by accretion rather than by design**:
`#32` added `ON TURN` to the seating rows and `#308` put the acting player's name and cash on the action
bar. Three surfaces, one fact — **and the panel was the weakest of the three, because it named the seat
without saying where that seat sat in the order**, which is the question a player in an auction actually
has. The seating table answers both at once.
**What does NOT go is the hint line** — it says where the controls are, which nothing else on this screen
does, and it was merely housed in the same panel.

### WaterfallAuctionDashboard.tsx #341 — The table is the panel
**Reported:** remove the large text-explanation panel at the bottom of the Auction tab; expand the
Seating Order to full width and add a column for the privates each player owns.
The hint block was the last survivor of the old footer and had the same weakness: **prose about where
the controls are, on a screen where the controls are on the cards a few inches above and labelled.**
What replaces it is not empty space — the seating table takes the whole width and spends it on the
column the auction was missing: **who owns what.** Cash says what a player can still bid; the privates
say what they have already committed to and what income they are drawing.

### WaterfallAuctionDashboard.tsx #391 — The catalog moved to `utils/privateCatalog.ts`
So this dashboard and `StockRoundPanel`'s private rows describe the same company from one source. See
`#312` for the reservation correction that catalog carries.

### WaterfallAuctionDashboard.tsx #547 — The concluding button moved to `AuctionPromptModal`
It sat at the foot of a scrolling six-card grid — **the last place a player who has finished reading is
still looking — which is the visible form of the problem `#306` named: the round was waiting on an
action nobody could see they had to take.** The banner stays, because the grid still needs to say why it
is empty.

### WaterfallAuctionDashboard.tsx #610 — The pass counter moved to the seats it counted
Deleted: "— 3 consecutive pass(es) so far" / "— no passes yet". **It was a number describing a roster
elsewhere on the screen, so reading it meant counting backwards round the table yourself** to work out
whether it had reached you — and "no passes yet" was a whole clause spent saying nothing had happened.
The PASSED stamps on the action bar **are** that count, drawn on the seats it is about.
`consecutive_waterfall_passes` is still read, by `App.tsx #610`'s `passedSeats`. **The figure did not
stop mattering; it stopped being prose.**

---

# The Buy Trains panel — `TrainPurchasePanel.tsx`

### TrainPurchasePanel.tsx #0 — Why bank and corporation are not one control
A corporation in the Hardware sub-phase can acquire a train two ways, **and they are different transactions
in every respect that matters:**

| | |
|---|---|
| **From the bank depot** | fixed price, finite printed supply, strict cheapest-first queue, and a purchase that can END THE PHASE — buying the depot's last 3-train launches Phase 4 and rusts every 2-train on the board. **Nobody consents; the bank always sells.** |
| **From another corporation** | any price of $1 or more, no supply question, no phase advance and no rusting — **and a counterparty who has to agree**, unless one player presides over both. |

The old arrangement put the corporate offer form under one heading and the depot purchase in a separate tray
elsewhere on the page, **so the two halves of one decision were never on screen together.** This is one panel
with two sections, **and the corporate half is COLLAPSED by default because the bank is the ordinary case and
a trade is the exception.**

### TrainPurchasePanel.tsx #1 — The quantity field is a convenience, not a batch
`BuyHardwareFromPool` carries no quantity, **so "buy 3" is three sequential messages** — exactly as the Stock
Round's multi-buy is N sequential `BuyStock`s (`App.tsx #42`), **and for the same reason: firing them in
parallel would race the depot's own accounting and could leave a corporation having bought fewer trains than
the log claims.**
The cap is `min(depot supply, train limit − owned)` and the control **LISTS it rather than validating against
it** — a `<select>` whose options are exactly the buyable quantities, **so there is nothing to type and nothing
to reject.**
**One tier per submission, deliberately.** 1830's depot is a strict queue — only the cheapest tier in stock is
purchasable — **so a player who wants a 3-train and a 4-train is describing two separate situations separated
by a phase change, not one order. The panel says so rather than offering a basket that cannot exist.**

### TrainPurchasePanel.tsx #2 / #282 — A train badge is the whole interaction
Composing a trade used to mean three dropdowns. **The middle one was the problem:** it listed all six models
whether or not the seller owned any, **so the commonest question ("who has a 4-train I could buy?") was
answered by opening six dropdowns one seller at a time.** The roster now shows every corporation's actual
trains as clickable badges — **the question is answered by looking, and clicking the answer IS the selection.**
**#282 — one badge per train, not a count.** They were grouped, a single "3" badge wearing an "×2". **Compact,
and wrong for what this row is: a rack of things to click.** A count is a summary, and a summary is right when
the reader wants HOW MANY; **here the reader wants WHICH, because each badge is an offer about one specific
train. "3 ×2" makes the player do arithmetic to learn that two separate purchases are available, and it renders
two purchasable objects as one object with a footnote.** It also mismatched the fleet everywhere else — the
corporation table has always drawn one chip per train, **so the same roster read "3 3" there and "3 ×2" here.**
`position` indexes into the seller's `owned_trains` **purely so the badge the player clicked is the badge that
looks selected** — the dispatch names only the model, since one 3-train is interchangeable with another.

### TrainPurchasePanel.tsx #3 — One train per trade
`BuyTrainFromCorporation` names a single model and no count, and `train_trade.rs` records one offer at a time
per buyer. **A multi-train trade would therefore be several offers, each separately acceptable — which is a
negotiation the contract cannot express and this panel will not pretend to.** The limit is **stated in the UI
rather than merely enforced, so a player planning a two-train deal finds out before composing it.**

### TrainPurchasePanel.tsx #230 — The train limit is a second, tighter ceiling
**Reported:** the Buy Trains action lets a corporation exceed its maximum train limit.
The panel capped quantity at the DEPOT'S SUPPLY and nothing else. **1830 caps holdings per corporation by
PHASE — four through Phases 2–3, three in Phase 4, two from Phase 5 — and the depot data already reports that
figure. It was being displayed and not enforced, which is the worst of both: the number was on screen while the
control ignored it.**
**The binding ceiling is whichever is smaller**, and the message names whichever one bit.
**Zero headroom is its own state, not a quantity error.** "Enter a number between 1 and 0" is nonsense; **"Train
limit reached" is the actual situation, and it is a reason to move on rather than to retype.**

### TrainPurchasePanel.tsx #296 — The number was already in the future tense
**Reported:** the train-limit readout shows the limit that will apply AFTER the purchase, labelled as though it
were the current one. A previous pass renamed it "Corp train limit", which fixed a different confusion and left
this one — **arguably made it worse, since a more confident label on a wrong-tense number is a more convincing
wrong answer.**
**The bug is in the VALUE, not only the words.** It read `nextTier.trainLimit`, and that field means "trains one
corporation may hold ONCE THIS TIER IS THE CURRENT PHASE" — **and the next tier is not the current phase whenever
the depot has moved on. In Phase 3 with the 2s and 3s sold out, the panel read "/ 3" while the real limit was 4.
Measured on the real fixture before this note was written.**
Both figures are now derived and named: the phase the corporation is in **right now**, and the phase the next
purchase **brings**. They are equal on the ordinary purchase and differ on exactly the purchase that advances the
phase — **which is the one worth warning about**, and it is amber on **both** the label and the value, because
**an amber number under a grey "Current Train Limit" would be the same wrong reading in a different colour.**
Amber rather than red: **the ceiling is moving, which is a consequence to plan around, not an error.**
**Enforcement stays on the after-value, deliberately:** buying the first 4-train starts Phase 4 and the limit
drops with it, **so capping against the old one would offer a quantity the rules take back.**

### TrainPurchasePanel.tsx #219 — The cap moves while the field is sitting there
**Clamping on keystroke is not enough on its own.** The depot's supply is derived from what every corporation
owns, so it drops when ANY of them buys. Two ordinary sequences leave a stale number in the box: buying 2 of 3
remaining trains, or another player's purchase landing on a poll while this panel is open.
The submit guard catches both, **but a field showing a number the player cannot buy, next to a button that
refuses it, reads as the UI being broken rather than as the depot having moved.**
**Downward only.** A supply that grows (it cannot today, but a tier change shifts the cap) **must not silently
raise a quantity the player typed — that would be the UI buying more than they asked for.**

### TrainPurchasePanel.tsx #247 — A dropdown that lists what is buyable
**Reported:** the depot shows 2 of 5 left, but 2 cannot be selected. **Both halves were true and it was not one
bug.**
**It was not a dropdown.** It was `<input type="number">` that silently CLAMPED: typing 2 against a ceiling of 1
rewrote the field mid-keystroke, **which is indistinguishable from the control refusing to accept the digit —
exactly how it was reported. A clamp is the right behaviour and the wrong affordance: it enforces a rule the
player cannot see by undoing their input.**
**The ceiling was often the train limit, not the depot.** The cap is `min(depot, limit − owned)`, **so the panel
showed the depot's 2 and enforced the limit's 1 without ever mentioning the limit, and the two numbers on screen
could not be reconciled.**
A `<select>` fixes the first — nothing to type, nothing to clamp — and a named **binding ceiling** fixes the
second. It **says nothing at all when neither cap is close**: a permanent explanation of a constraint nobody is
hitting is noise.
**#294 — two numbers, two subjects.** "Quantity" sat beside a "Trains 2 / 4" readout and the pair was routinely
read as one thing. **They are facts about different subjects: one counts cardboard in the bank, the other caps a
corporation's holdings this phase. Naming the subject on each is the whole fix — neither number was wrong, and
neither said whose it was.** `#248` is why the limit is here at all: it explains why the quantity list stops
where it does, **and it was only available on the Operating Round strip — a different panel from the one
enforcing it.**

### TrainPurchasePanel.tsx #281 — The limit is on holdings, not on the bank
**Reported:** the UI permits buying from other corporations even at or over the train limit.
**The shape of the miss is instructive:** `#230` had already enforced the cap on the BANK section thoroughly,
and the corporate section a few hundred lines below shared none of it — **because the cap had been reasoned
about as a property of buying FROM THE DEPOT rather than as a property of the corporation's fleet.**
**1830 caps what a corporation may HOLD. Where the train comes from is irrelevant.** So the same gate covers
both, **and the reason is the same sentence — it is the same rule, and giving it two wordings would imply two
rules.**
**It disables rather than hiding.** The rival's trains are still worth seeing: **knowing who holds what is what
tells a president which rivals are themselves train-locked, and who might come asking to buy one of theirs. A
vanished section would answer a question nobody asked by removing the one they did.**
**#485:** the reason no longer ends "Scrap or sell a train before buying another." **A corporation cannot scrap,
and the Bank does not buy trains back — the sentence instructed the player to take an action 1830 does not
contain.** The genuine rule is the one above: **a full fleet cannot accept another train from any source. That
is a lock, not a prerequisite, and it clears only when a rival corporation chooses to buy.**

### TrainPurchasePanel.tsx #232 — Only list corporations that have something to sell
**Reported:** the accordion lists corporations with "no trains". It listed all seven with a placeholder each, on
the reasoning that a complete roster is easier to scan. **In practice the opposite: early in a game most
corporations own nothing, so the panel was mostly rows that could not be acted on, and the two or three that
COULD were buried among them. The question this section answers is "who has a train I could buy", and a row that
answers "not this one" is noise.**
**`owned_trains` undefined is KEPT, and the distinction is load-bearing:** `undefined` means the chain did not
say, **which is emphatically not "owns nothing". Filtering those out would empty the whole section against such
a chain and make trading look removed rather than unsupported.**

### TrainPurchasePanel.tsx #618 / #633 / #634 — Six rows, then one row and a caret
**#618 — reported:** "each train has a large card/tile, but you can only ever interact with one of them … I
wonder if there is a way to compress things so that when this action panel pops up it does not devour 60% of
the screen?"
**Nothing is dropped — what changes is the AXIS.** Each tier was a five-line vertical stack about 100px tall,
wrapping into two or three rows of cards; the same six tiers as single lines are one column about a third the
height.
**And it reads better, which is the argument for doing it this way rather than just shrinking the cards.** The
question here is comparative — "how many 4-trains are left, and what does the 5 cost?" — **and a wrapping grid
puts those two figures in different places on different screen widths. Columns put every cost under every other
cost. The card layout was spending its height to make comparison harder.**
**The report's own observation is why this is safe:** "you can only ever interact with one of them". **The other
five are reference, and reference wants a table.**
**#633 — reported:** the panel is taking up the same vertical space as before. **Fair, and `#618` only did half
the job: turning six five-line cards into six one-line rows made each row shorter and kept all six on screen.
The height was never in the row's design; it was in the row COUNT.**
**Five of the six are reference.** The depot sells cheapest-first, **so exactly one tier is ever purchasable.**
The purchasable tier stands alone and the rest fold into a caret — the same accordion this file already uses for
corporate trades, and for the same reason: **the ordinary case is the open one.** The collapsed summary still
names what is next and what it costs.
`nextTier` is the split, **and rusted tiers go with the later ones rather than being dropped: a 2-train that has
left play is still the reason the board looks the way it does.** **No available tier is a real state** — every
tier sold out, which in 1830 means Diesels or over — **and the accordion then holds the whole depot, which is
honest: there is nothing to buy and the panel says so by having nothing in the top slot.**
**#634 — the "For sale" badge is retired.** It was always a workaround for the layout rather than a fact worth
stating: **six near-identical rows needed one of them marked; a single row standing above a caret labelled
"Later trains" is marked by position, which is the stronger signal and costs no width.**

### TrainPurchasePanel.tsx #283 — What happens to this tier, next
A depot card said how many were left and, once they were gone, nothing. **Sold out is not the end of a tier's
story — it is the middle.** The 3-trains leaving the depot is the moment every 3-train ON THE BOARD becomes a
liability, **and the card went quiet exactly then.**
So the fate rides on every card that has one, sold out or not. **"Permanent" is worth its own badge rather than
an absence:** a player weighing $630 for a 6-train against $300 for a 4 **is weighing precisely the fact that one
of them never dies, and an empty space does not state it.** Not shown once it has already happened — **a
countdown to something that has occurred is noise.**

### TrainPurchasePanel.tsx #617 — A train that looks like a train, and counts
**Reported:** "is there some way to have train icons for each type? I think it may be very abstract for new
players to buy '2' when they're buying a train."
**Inline SVG is the answer to the emoji problem.** It is drawn by this file, from these coordinates, on every
device — **there is no font to substitute, no vendor glyph set, and no colour-emoji fallback. The objection that
ruled emojis out does not apply to a path we ship ourselves.**
**The carriages are the tier, which is the part worth having.** A generic locomotive would say "train" and stop;
**what a new player actually needs to learn is that the NUMBER IS A CAPACITY — a 3-train runs three revenue
centres.** So the glyph is a locomotive plus one carriage per centre, and "buy a 3" becomes a picture of the
thing it buys. **That teaches the rule the abstraction was hiding rather than merely decorating it.**
**Diesel is drawn, not counted.** A D-train has no fixed length, **so a carriage count would be a lie in the one
case where the number is not a number.** It gets a trailing ellipsis of dots: visibly "and onward", visibly not a
count.
**Purely decorative to assistive tech** — every glyph sits beside the tier already written as text, so
`aria-hidden` keeps a screen reader from hearing the same fact twice.

### TrainPurchasePanel.tsx #632 / #635 — The era palette, and a cursor that promised nothing
**#632:** the tile colours a player already knows, **adjusted to be legible as INK on a near-black panel rather
than as fills on a map. Brown is the case that forces the adjustment** — the tile brown is a fill colour and
reads as mud at 12px on `#12141b`, so the ink is a warm tan that still says "brown era".
**Not pulled from the tile catalog, deliberately:** those values are chosen to be correct as large filled hexes
on a light board, **and reusing them here would be sharing a number that happens to match rather than a
decision.** What IS shared is the tier-to-era **mapping**, which is the part that would actually be wrong if it
drifted.
**#635 — reported:** "when my mouse is over the train list, it gains a `?` icon … as though clicking them would
do something, but nothing happens." `cursor: help` was inherited from the card layout, **where it was arguably
right: a card with five lines of detail and a tooltip explaining the queue rule is a thing you interrogate. A
one-line row whose four columns are already on screen has nothing left to reveal, so the cursor was promising an
interaction that had been designed away.** The tooltips stay — **they just should not change the pointer.**

### TrainPurchasePanel.tsx #508 — Condensed, because a sticky panel costs the board its height
This panel is mounted INSIDE `ContextualActionBar`, which is `position: sticky` — **so it follows the player down
the page instead of being scrolled away from, which is also what retires `#491`'s jump button.**
**`condensed` is what makes that affordable.** A sticky element costs the board its full height for the whole
scroll (`#298`), so **the pinned form drops what is PROSE and keeps what is CONTROL:** the tier, the price, the
quantity and the Buy button. The quantity explanation is the longest piece of prose in the panel and **explains a
rule rather than a value — read once, not on every scroll — so it is the first thing the condensed form gives
back to the board.**
**The corporate accordion needs no special handling** — already collapsed by default, header still reachable, **so
a trade is one click away in either state rather than being hidden by the collapse.**
The counterparty's Accept/Reject is **deliberately the same shape and the same corner as `PrivateTradePrompt`:
these are the two consent flows in the app, they interrupt at the same moment in a turn, and a player should not
have to learn two different affordances for "somebody is asking you to agree to something".**
`countByModel` is **gone with `#282`** — it collapsed a roster into model-and-count and nothing else ever wanted
that shape. **Deleted rather than left unused so the grouped rendering cannot quietly come back.**
The accordion's initial-open flag exists **so the section can be rendered without a DOM to click it open with: a
test that cannot reach a surface cannot check it, and this section carries the train-limit gate.**

---

# The Game Ledger — `FinancialLedger.tsx`

### FinancialLedger.tsx #1 / #3 — Real data, and an honest design gap
Bank cash (`virtual_bank_vgp` / `virtual_bank_start`, VGP) and the real-JUNO ante pool (`total_juno_pool`) are
genuine `GameStateResponse` fields, rendered directly.
**#3 — the Hardware Shop is an honest DESIGN GAP, not a fabricated shop.** `state.rs` has a real
`HARDWARE_POOL`/`COMPANY_HARDWARE` map and `hardware.rs` a real `TRAIN_CATALOG`, **but zero `QueryMsg` variant
reads either back.** This surfaces as an explicit "Not yet exposed by contract" cell per corporation plus one
shared footnote, **rather than inventing plausible-looking inventory counts.**

### FinancialLedger.tsx #4 / #497 / #497a — The chain first, then the board
**#4** established net worth as the real `QueryMsg::PlayerNetWorth` figure — cash plus every certificate priced at
its LIVE market value, summed on-chain — **and argued this panel could not compute it itself**, since
`GameStateResponse` carries `par_value` but not the live price, **so reproducing it would mean either a second
query plus duplicating the backend's valuation math, or silently substituting par for market. Both worse than
calling the dedicated endpoint.**
**#497 — reported:** the ledger shows "not connected" for Stock Value and Net Worth, masking local sandbox
figures behind a wallet check. **It did.** The gate is `queryClient && contractAddress && gameId`, **and a
sandbox has none of the three — so both columns fell to the placeholder for the whole of offline mode, on the one
screen whose job is to total up what everybody owns.**
**The premise expired.** `marketGrid` has since become a PROP of this panel (`#14`), and the player table already
unpacks it into a price map for certificate exemptions — **the live prices `#4` says would need a second query
are sitting in the same function that prints "not connected".** So the valuation is derivable, **and `#4`'s own
escape clause is honoured: this reads the live price and returns `null` for a corporation that has none, rather
than quietly pricing it at par.**
**#497a — an estimate that knows it is one.** This does NOT replace the chain's figure; **what it replaces is the
BLANK.** The distinction matters because the two can legitimately differ — the contract may value things this
does not know about, **and a client-side total presented as authoritative would be `#4`'s "silently substituting"
failure wearing a different hat.**
**`null` propagates rather than being coerced to zero:** a player holding a corporation with no market position
has an UNKNOWN portfolio value, not a zero one, **and reporting "$0 net worth" for someone holding five
certificates is worse than reporting nothing at all.**
**Precedence, most authoritative first:** the chain's `PlayerNetWorth` → the same arithmetic over holdings and
live prices this table already has in hand → a placeholder saying why. **"Not connected" is the last resort now
rather than the offline default — reached only when there is no query AND no market grid, at which point the cell
really does have nothing behind it.**

### FinancialLedger.tsx #555 — This is arithmetic, not an estimate
**Reported:** Stock Value and Net Worth are both prefixed with `~`, as though they were guesses. **There is no
guessing these values.**
Correct, **and the `~` was answering a real question with the wrong symbol.** `#497a` added it to mark the
locally-computed figure as distinct from the contract's — a sound concern. **But the two are not an approximation
and an authority. They are the SAME SUM over the same inputs: cash on hand, plus each holding multiplied by its
live market price. Nothing is rounded down, sampled or inferred.** The distinction that matters is
**PROVENANCE — who did the addition — and `~` does not mean "computed here", it means "roughly", which is a claim
about accuracy that was never true.**
**The tooltip stays and does the job properly:** provenance belongs in words, where it can say which arithmetic
ran and where, **attached to precisely the cells the client computed.** (`estimateCertificateCount` was renamed
for exactly this reason; **this is the same correction, one column over and overdue.**)

### FinancialLedger.tsx #7 / #14 — One table, not a table plus a tree; one table, not two
**#7:** "Player Assets" and "Player Certificate Trees" were two views of one thing. **Answering "does Alice have
the certificates AND the cash to take this company?" meant reading a table, scrolling to a grid of cards, finding
the same player again, and holding both halves in your head.** They are one table now, with certificates and the
holdings themselves as columns. The tree's per-card net-worth row is dropped as duplicative, **and its footnote is
gone entirely: it explained that the certificate count was a client-side estimate, which is no longer true and was
a development note in a player-facing UI regardless.**
**#14:** "Corporation Assets" and "Corporate Stock Distribution" were two tables with **the same rows in the same
order, stacked** — so answering the only question the ledger exists for meant reading treasury and trains in one,
scrolling, finding the same ticker again, and reading IPO and pool split in the other.
The column order follows how the question is actually asked: **WHO it is** (corporation, president), **WHAT IT IS
WORTH** (market price, treasury), **WHAT IT CAN DO** (trains, limit, last payout), **WHO HOLDS IT** (IPO, bank
pool, player hands).
**The Total column is deleted.** It summed the three ownership columns as a visible reconciliation check, on the
reasoning that a mismatch would indicate a contract bug. **That reasoning was sound and the column still had to
go: it printed "100%" on every row of every game, so the one time it mattered it would be a single digit changing
in a column nobody had read in months. A checker that cries wolf by never crying is not a checker.**

### FinancialLedger.tsx #16 — The bank depot inventory
Which trains are left, what they cost, and what buying one sets off, in one place — **each previously discoverable
only by counting other corporations' holdings by hand, which is a lot of work to answer "can I afford to wait a
turn".**
**It lives in the BANK section rather than with the corporations because the depot belongs to the bank — it is
stock nobody owns yet.** The Corporation Assets table answers "who has what"; this answers "what is still for
sale".
The per-tier counts come from the **queue rule**, not by subtracting owned trains from printed totals — **that
shortcut is unsound for obsolete tiers and would report rusted trains as though they were still on the shelf.**
**Two dimmed states, not one.** Sold out and rusted are different facts: **a tier can be unbuyable while its
trains still run** (every 3-train keeps earning through Phases 4 and 5), **and only a genuinely rusted tier gets
the strikethrough, because only then is it gone.** The tier chip is the same one the corporation rows use, with
the rust tint deliberately off — **the tint means "a corporation's train is about to die", and this is a price
list, not a holding.**

### FinancialLedger.tsx #405 — One Player Assets table, two places
**Reported:** the Stock Round footer prints raw addresses; replace it with a replication of this table.
**"A replication of" is the phrase that decides the implementation.** Building a second table would replicate the
LOOK and then drift on everything else — **the certificate-limit exemption needs live market prices, the money
columns need the net-worth query and its three distinct pending states, and none of that survives being copied by
eye.** The footer renders THIS component instead.
**The raw-address problem is not fixed by the move, and an earlier draft of this note claimed it was.** It was
wrong: this table truncated exactly as the footer did, only shorter. The fix is an optional `playerLabel`,
resolved the way every other roster resolves a seat. **Recorded rather than quietly corrected, because a note
asserting a fix that does not exist is worse than no note.**
The label resolver is the **room-aware** one (`#559`): importing it from the sandbox fixture got the Alice/Bob
table, which returns null for a real room id — **so presidents rendered as raw ids here while every other surface
showed names.**

### FinancialLedger.tsx #423 / #407 — The same pills the auction uses, carrying the revenue
**#423:** this cell and the auction's seating table were two hand-rolled renderers for one thing, **and they had
already drifted into disagreeing about what a private looks like** — the auction showed a bare numeral, this
showed the full name with revenue appended, **and neither could be clicked.** One component is now both. **It also
fixes the column's height:** full names wrapped, so a player holding three privates got a three-line row and the
whole table went ragged.
**#407 — reported:** privates must display their per-OR revenue wherever they are listed outside the auction —
**it is what certificate-exchange timing is judged on.** Every one of these lists already KNEW the figure and
**spent it on a `title` attribute. A tooltip is not a display: it needs a pointer, it needs a pause, and it shows
one private at a time — so comparing "which of these three is worth holding through Phase 5" meant hovering three
chips in sequence and remembering two numbers.** The auction is exempt because there the revenue is already the
headline of every card.

### FinancialLedger.tsx (smaller entries)
- **#12** — the ante pool arrives as `ujuno`, so 40 JUNO reads as 40000000 raw. Converted through the shared
  helper rather than by dividing here: **that helper does the six decimal places with integer string math, because
  a `Uint128` above 2⁵³ loses precision the moment it becomes a double, and a pool of real money is the last place
  to be quietly wrong.**
- **#13** — each corporation's brand colour applied to the ink and a hairline underline rather than as a filled
  background: **eight saturated fills across a header row would out-shout the percentages underneath, which are
  the data. The colour is a wayfinding aid for tracking one column down a tall table, not a highlight.**
- **#15** — the crown sits LEFT of the number. On the right it sat inside the right-aligned edge, **so a
  president's row was pushed left by the glyph's width and its percentage no longer lined up. Moving it left puts
  the variable-width element on the ragged side and leaves the digits flush, which is the entire point of a
  right-aligned numeric column.**
- **#5** — "Game Ledger" is a **display-text rename only.** The component, export and file name are deliberately
  left alone: **a UI copy request scoped to tab renaming is read as changing what a player reads, not as a mandate
  to rename a source module and touch every file that imports it.**
- **#6** — real `<table>` elements, each in a horizontally-scrolling container **so a dense table degrades to a
  scrollbar rather than an unreadable reflow on a narrow pane.**
- **#8 (column rules)** — `*Num` right-justifies and the `*B` suffix adds the vertical rule. **The rule lives on
  `borderRight` rather than `borderLeft` so the LAST column can use the plain variant and not draw an edge** —
  with `borderLeft` the same trick would have to be applied to the first column, which reads worse when scanning
  the style names.
- **#32 / #552** — the Priority Deal marker is bare text, no pill: **this sits beside a name in a dense table that
  already carries a crown and an ACTIVE badge elsewhere, and a third boxed element would turn the name column into
  a row of competing containers.** `cursor: help` is what signals the tooltip exists at all. The crown's `color` is
  back and **now does something — it was removed when this styled an emoji, which ignores it; the SVG fills with
  `currentColor`.**
- **#423 / #379 (style deletions)** — the private-column styles are **deleted with their markup rather than left to
  rot.** Privates render as chips rather than a comma list: **a corporation holds at most a couple, and each is a
  discrete asset with its own revenue, so they read as objects rather than as prose.**
- **#43 (badge chip)** — slate, not amber: **it sat a few hundred pixels from the Bank Depot's amber CURRENT pill
  and the two read as one inconsistent style rather than two unrelated states.** `FONT_SIZE.micro` rather than a
  literal 12px, **because `typography.ts` scaled the whole ramp up on purpose and a hardcoded size would silently
  opt out of that decision.**
- **The net-worth hook is called unconditionally** (React hook rules) even before `gameState` resolves — it no-ops
  cleanly on an empty address list, **and the fresh-array-every-render is safe because the hook depends only on the
  joined content** (`utils_layer.md`, `gameState.ts #6`).

---

# The privates' powers — `components/PrivatePowerPanel.tsx`

### PrivatePowerPanel.tsx #0 / #1 — What these buttons honestly are
**Reported:** there is no UI to activate a private's special ability. **True, and the privates were otherwise fully
modelled** — auctioned, owned, paying revenue each Operating Round, closing at Phase 5. **Everything except the one
thing that makes them interesting to own.**
**`ExecuteMsg` has no variant for using a private's power.** There is no `UsePrivateAbility`, and
`GAMEPLAY_MESSAGE_KEYS` — **the session key's on-chain allow-list, not merely a client convenience** — could not
carry one if there were.
**So a button here CANNOT dispatch to the contract, and pretending otherwise would be the worst available outcome:
a control that broadcasts a message certain to be rejected, or worse, one that logs a success the chain never saw.
This codebase has removed exactly that shape twice (`App.tsx #162`, `#193`).**
These are **sandbox-only controls, and they say so.** Outside sandbox the panel does not render at all **rather than
showing a row of dead buttons whose tooltip explains a backend gap the player cannot close.**
**What is and is not modelled:** the reducer action marks the ability **used** and logs it. **It does not lay the
tile, place the station or move the certificate — each of those is real map or share logic, and inventing a
half-version is how a mock starts disagreeing with the contract.** The button exists so the surface and both gates
can be exercised now, **and so wiring real behaviour later is filling in a handler rather than designing a UI.**

### PrivatePowerPanel.tsx #2 / #349 / #470 — Two gates, and how coarse they may be
**Ownership** is a fact about the board; **phase** is a rule. **Both are shown rather than one hiding the other:** a
player who owns the D&H wants to know it is theirs during a Stock Round even though they cannot fire it until they
operate. An out-of-phase ability renders **disabled with the reason**; one they do not own is **absent entirely** —
**listing every private with five "not yours" rows would be the roster problem `TrainPurchasePanel #232` already
fixed once.**
**#349 — a round is not precise enough.** *Reported:* the C&SL track-lay power shows up during the Stock Round.
**Two things were wrong and the first hid the second. It was not actually showing in a Stock Round** — it rendered
DISABLED with "Only usable during an Operating Round". **Disabled, but present: a row with the company's name and a
greyed button, in a panel titled Private Powers, on a screen where the power cannot be used at all.** `#2`'s
argument for showing an out-of-phase ability **holds for a power the player will use LATER THIS ROUND — it does not
hold across a round boundary, where the answer is simply "not now, and not for a while".**
**And the gate was too coarse.** Even inside an Operating Round, a free tile lay is only legal during Lay Track —
**offering it during Run Routes is offering an action the contract refuses.** The type had no way to say so, **so
the panel could not have been right even in principle.** It now carries an optional **sub-phase**; absent means "any
sub-phase of that round", **which is the honest default for the powers that genuinely are round-wide.**
**#470 — the out-of-round powers leaked into the OR.** *Reported:* the panel leaks into the Operating Round action
panel even when the acting corporation does not own the private. **`#441`'s half held.** The leak was the two
PLAYER-scoped exchanges: their phase is `"StockRound"` and neither opted into hiding, **so during an Operating Round
they rendered DISABLED — a Private Powers heading and two dead rows, on a panel whose entire subject is the acting
corporation, describing privates that corporation does not own and cannot use.**
`#349` introduced the opt-in reasoning that a disabled row is "useful context rather than noise" **when the wait is
short. That is true of a power the viewer will use SOON on this same panel. It is not true here: the Operating
Round's panel belongs to a corporation, and a player's personal share exchange has no relationship to it at all —
the wait is not short, it is a different subject.**
**So the round must match, always.** The opt-in **becomes redundant rather than wrong, and is left on the two
entries that set it as a statement of intent; nothing now depends on it. A power is shown in its own round or not at
all.**

### PrivatePowerPanel.tsx #441 — Who owns a power is not who owns the private
**Reported:** the PRR President sees the D&H's power even when the PRR does not own the D&H.
The panel filtered on `priv.owner === viewerAddress` — **a PLAYER-level test — and applied it to every ability
alike. That is right for half of them and wrong for the other half, and 1830 draws the line in the text of the
powers themselves:**

> "A **player** owning the MH may exchange it for a 10% share of NYC"
> "A **railroad** owning the DH may lay a track tile and a station token"

**The exchanges belong to a PERSON and fire on their stock turn. The track powers belong to a CORPORATION and fire
on its operating turn.** A private sitting in a player's pocket confers no track power on anything — **the protocol
id is null until a corporation buys it, and until then there is no railroad owning the DH for the rule to name.**
**So the scope is a property of each ability rather than an assumption the panel makes once for all of them.**
**Two ownership tests, one per scope.** For CORPORATION scope **both halves are load-bearing:** without the first, a
president whose corporation does not own the D&H sees its power (the reported bug); **without the second, every
player at the table sees a button only one of them may press.** `#470` tightens it to **exact identity** — the
protocol id must equal the corporation currently operating, **not merely be non-null, and not the president's other
corporation.**

### PrivatePowerPanel.tsx #442 — The D&H is two powers, and F16 is not free
**Reported:** the D&H caption is misleading and its single "Place Station" button does nothing.
The caption read "may lay a tile AND place a station on F16 at no cost", **which is wrong twice over and wrong in
the direction that costs a player money.** `privateCatalog.ts` carries the rule explicitly: **"The mountain costs
$120 as usual, but laying the token is free." Only the TOKEN is free. A caption promising a free tile on a $120
mountain hex is an invitation to a purchase the player cannot afford to have misjudged.**
**"AND" was the second error.** The rulebook grants the tile and the token **independently** — a corporation may take
either, both, or neither — **and one button could not express that, which is also why the one button had nothing
coherent to do.**
The spent-marker is therefore **keyed per ACTION, not per private: keying by `private_id` would have made either one
consume the other.**

### PrivatePowerPanel.tsx #350 → #576 — Camden & Amboy, added and then un-buttoned
**#350 — reported:** the private that exchanges for a PRR certificate should be visible and actionable during the
Stock Round. The comment that stood there said C&A "is granted on purchase rather than triggered", **and the auction
catalog had described it as an exchange since it was written** — so a button was added.
**#576 — that is not the rule.** The share arrives on **purchase**, free, **and the company STAYS OPEN and goes on
paying $25 an Operating Round.** `privateCatalog.ts` says so, `#360` recorded it as a correction to an older
paraphrase, and the auction now grants it where the win resolves.
**So the row keeps its DESCRIPTION** — a player looking here should still learn what the company did for them —
**and loses the control, because there is nothing left for the owner to trigger.** An empty action list renders the
text without a button, **which is the honest shape for a power that has already happened.**
**Not deleted entirely, deliberately: a C&A owner who finds no row at all would reasonably conclude the company has
no power, which is the confusion `#350` was originally written to fix.**

### PrivatePowerPanel.tsx #441 (B&O) — The row is gone, not restricted
**Reported:** hide "Take B&O presidency" during the Stock Round — it serves no purpose once the B&O is parred.
Its phase was `"StockRound"`, **so hiding it there hides it everywhere: the requirement is a deletion written as a
restriction.** And it should be deleted, **because the button had already been overtaken.** `#399` moved the grant to
the moment the private is **won** — the par prompt hands over the certificate and takes the price in one blocking
step, **because a presided-over company with no price is a state `#387` refuses to render. By the time any Stock
Round exists the presidency is long since granted, so this button offered to do a thing that had already happened.**
**The B&O is still visible to its owner everywhere privates are listed. What is removed is a control, not
information.**

### PrivatePowerPanel.tsx #573b / #443 — Why it refused, and what it costs to find out
**Reported:** "the Exchange button should return an error that they are at the limit and the power should be
maintained for a subsequent round."
**A disabled button would not do.** The exchange's legality depends on the player's holding in a corporation this
panel does not otherwise read, **and the interesting refusals ("you hold 60% of the PRR", "no NYC certificate is
available") are facts about somewhere else on the board. A greyed control with a tooltip is right when the reason is
local; this one has to be a sentence the player can act on.**
**Shown after the attempt rather than pre-emptively, because the attempt costs nothing** — the power stays intact on
a refusal, **so clicking to find out is a legitimate way to ask.**
**#443 — the revenue, where the decision is.** *Reported:* the Mohawk and Camden can be exchanged for shares, but
their Operating Round revenue is not visible for comparison. **Both exchanges are a trade: give up a certificate that
pays every Operating Round, receive a 10% share that pays dividends and can be sold. A player weighing that needs the
figure they are giving up, and this panel — the one surface carrying the exchange BUTTON — was the one place on the
tab that did not show it.**
**It rides on the name rather than in the description because it is a NUMBER a player scans for, and a figure buried
mid-sentence in a rules paragraph is not scannable.**

---

# The private trade engine — `components/PrivateTradePanel.tsx`

### PrivateTradePanel.tsx #0 — The consent step is not on chain yet
**In 1830 a corporation buying a private from a player is a NEGOTIATION.** Both sides must agree: the president names
a price, the owner takes it or refuses. **This component implements that. `ExecuteMsg::BuyPrivateCompany` does
not** — it is single-party, authorising the buying corporation's president, checking the phase gate, the cursor, the
treasury and the price band, **and then moving the private. The seller is read (`private.owner`) but never asked.**

| | |
|---|---|
| **Sandbox** | the local reducer is the only authority there is, **so the full two-party flow is real. Nothing is being faked relative to an authority, because there is no other authority.** |
| **A live room** | **the seller CANNOT be sent this proposal.** No message carries it and no query surfaces it, **so their client would never learn it exists. Showing them an Accept button would be theatre.** The prompt is shown to the PROPOSER and labelled as what it is: a confirmation before a purchase the contract will execute unilaterally — **and `onConfirmUnilateral` is deliberately named to make a call site that treats it as consent look wrong.** |

**⚠ The backend shape this needs already exists, one feature over.** Train trading between corporations with
different presidents records a `TrainOffer` and waits for `AcceptTrainOffer`/`RejectTrainOffer`, with a rescind path
and a `GetTrainOffers` query. **A `PrivateCompanyOffer` mirroring it would make this component's live path as real as
its sandbox one. That is a backend change and out of scope here; recorded so the gap is actionable rather than merely
known.**
**#2 — why sandbox lets one person answer their own offer.** A hotseat sandbox has one wallet and one human, **and
requiring the owner's client to answer would make this flow untestable there — which is the one place it most needs
to be testable, since it is the only place the whole two-party sequence can currently run end to end.** The prompt
still **names** the owner, **so the person clicking Accept is always told whose decision they are standing in for.**

### PrivateTradePanel.tsx #1 — The price band is mirrored, not invented
`trading.rs`: "Pricing guardrails: `price` must land in [50%, 200%] of face value." The input clamps to the same band
**so a player finds out at the point of typing rather than from a rejected transaction.**
**This is client-side validation of a rule the contract also enforces — ordinarily the thing this codebase avoids.
It is acceptable HERE for the same reason the four static tile-lay gates are: the band is a STATIC arithmetic
property of one number, not a stateful judgement about the board. It cannot go stale between render and dispatch, and
the contract still has the final say.**
**`ceil` on the floor and `floor` on the ceiling**, so a rounded bound can never fall OUTSIDE the band the contract
checks — **rounding the other way would offer a price that looks legal here and is rejected on chain, which is the
one failure this mirror exists to prevent.**

### PrivateTradePanel.tsx #386 — Show the unsold ones, disabled
**Reported:** the sub-phase should display all available private companies, clearly marking which player owns them.
The strict predicate answers a narrower question — **which ones can a corporation propose for RIGHT NOW.** It excludes
privates still unsold in the auction, because there is no seller to agree, **and that exclusion is correct for
dispatch. It was wrong for DISPLAY, and the difference is what a player learns from an empty list:**

| | |
|---|---|
| **filtered out** | "No private company is available" — **which reads as "there are none", when there may be four sitting in the auction that this corporation could buy next round.** |
| **shown, disabled** | "C&SL — unsold in the auction" — **the actual state of the game, and it tells the player where the private went and what has to change.** |

**The two functions stay separate rather than one function with a flag, because they answer genuinely different
questions and the dispatch path must keep using the strict one — a display predicate that quietly became the legality
predicate is exactly how an unsendable proposal reaches the chain.**
**Who holds it is named** — and for an unsold private that is **also the explanation for why the row is inert, so the
two facts are one line rather than two.**

### PrivateTradePanel.tsx #660a — A rule enforced in a function that never runs
Found while adding the B&O sale ban to it: **nothing called it.** The modal renders from the LOOSE list and decides
what may be proposed by resolving the selection against the block-reason helper. **This function was a third answer to
a question already answered twice, and the ban had been added to the one copy no player could reach.**
**Which is the exact failure this codebase keeps rediscovering, caught this time by asking who the caller was before
trusting the fix: a rule can be written, tested, and enforced in a function that never runs. `tsc` and ESLint are both
content — the export is used, by the test that was written to prove the rule.**
**The rule still holds, in the two places that matter:** the block-reason helper refuses the selection so the price
field and the propose button never address the B&O, and the reducer refuses the message even if one is somehow
written. **UI and reducer, which is where `#660` said it should be.**
**The B&O is still shown, inert, with its reason and its power text.** `#386`'s argument for rendering an unbuyable
row — "the whole point of showing it is that the player learns the private exists" — **applies more strongly to a
certificate no corporation may ever buy, not less. Hiding it would leave a player wondering where it went.**

### PrivateTradePanel.tsx #661 — A row per private, at a readable size
**Instructed:** "the fonts are very small, and everything is listed in a string whereas I think it might be a little
more digestible with some styling."
**Both halves were true and they had one cause: every secondary fact on the row was `micro` (11px), the size the type
scale reserves for "tiny status pills and inline tags". Face value, revenue, owner and price band are not tags, they
are the DATA the decision is made from — and four 11px runs sitting on one line read as a single grey string however
they are marked up. Nothing was concatenating them; they just all looked the same and none was big enough to anchor
the eye.**
An explicit two-column grid, **so a player scanning six rows can read down a column rather than across a paragraph —
which is the actual difference between a list and a string.**
**The row is a group, not a button.** The whole row used to BE the `<button>`, fine while selecting was all it did.
**It now carries a second control — the power disclosure — and a button inside a button is invalid markup that
browsers repair by unnesting, which would have put the toggle outside the row it belongs to.** So the row is a
container with two real buttons: **the selectable face, and the disclosure. A player can read what a private DOES
without selecting it — the old row made "tell me more" and "I choose this" the same click.**
**The group carries the chrome, the face carries the click:** border, background and selected state moved to the group
**because the row now holds two buttons and a paragraph, and a border drawn on one of the three would frame part of a
row.**
**The POWER is on the face of the row.** A player choosing between six privates **is choosing between six powers, and
the face named every other attribute — price, revenue, owner, band — except the one the decision turns on.**

---

# The private catalog — `utils/privateCatalog.ts`

### privateCatalog.ts #391 — One copy of the descriptions
This table lived inside `WaterfallAuctionDashboard.tsx`, **which was the right home while the auction was the only
screen that described a private. It no longer is** — the condensed stock card expands them to their rules text, and
the Financial Ledger names them.
**One copy, imported by both, because two copies of a rules description will eventually differ and the failure is
silent — both read plausibly and only one matches what the game actually does.**
**Display source only:** nothing reads this to make a decision, **and it is a hand-kept mirror of
`auction.rs::CORE_PRIVATE_COMPANIES` that has to be updated by hand if the contract's abilities change.**

### privateCatalog.ts #548 — Described, not quoted
**Instructed:** remove the wording copied from the rules manual; rewrite and summarise instead.
These strings used to be the published rulebook's own sentences, carried verbatim down to the curly apostrophes, **and
the note they replace said so proudly: "normalising them to ASCII would be an edit, and once one edit is allowed the
text stops being quotable." That was a sound argument about FIDELITY and it was answering the wrong question. Quoting
a commercial rulebook at length in shipped software is a copyright exposure whatever its typography, and the accuracy
it was protecting does not require the publisher's words — only their meaning.**
**Game rules are not themselves copyrightable; the expression of them is.** Each line is written from scratch.
**Accuracy was the point of the quotation and it is still the point.** The paraphrases the verbatim text originally
replaced were wrong in four specific ways, **and every one is preserved here deliberately — this rewrite must not walk
back into them:**

| | |
|---|---|
| **D&H** | **the tile is NOT free.** The mountain costs the usual $120 and only the TOKEN is free, which is most of the value. **The tile also CONSUMES the corporation's normal placement.** |
| **C&SL** | **the opposite** — its lay is IN ADDITION to the normal placement, so the corporation may play two tiles that turn. |
| **M&H** | the exchange has **two conditions** (under 60% held, and an NYC share actually available) and may be taken **between other players' turns**, in either round type. |
| **C&A** | **is not an ability the owner triggers.** The share arrives on PURCHASE and the private stays open. |

**Schuylkill Valley canonically has no power at all, and its line says so outright rather than leaving a blank that
reads as missing data.**

### privateCatalog.ts #13 — The enforcement badges are gone, and what that costs
An earlier pass rendered an "⛓ ENFORCED" / "○ NOT IN THIS RULESET" badge beside each description, **because
`auction.rs` only implements three of the six powers. The badges are gone by explicit decision: all six privates are
required parts of this ruleset, and the card should describe the piece rather than annotate the current state of the
backend.**

> **⚠ Consequence, recorded on purpose. Two of the descriptions now state powers this contract does NOT implement:**
> the **Champlain & St. Lawrence**'s free tile lay on its home hex, and the **Camden & Amboy**'s exchange for a 10%
> PRR share. D&H, M&H and B&O are genuinely enforced — **though the hex-blocking text for D&H/M&H now states the
> official rule's two exceptions (owning corporation, or closure), and whether the contract honours BOTH of those is
> itself an audit question.**
> **Until those two are implemented, this UI describes an ability a player cannot exercise. That is a BACKEND gap, not
> a display bug. Do not "fix" it by editing the text back into vagueness — fix it in `auction.rs`.**

### privateCatalog.ts #661 — The power, in one line, before the paragraph
**Instructed:** "none of the Privates are listed with their special powers, which makes knowing what to buy somewhat
difficult … we need a short summary of each of their powers that can be clicked to expand."
The long `ability` text is **exactly right for the powers panel, where a player has gone to LEARN the piece. It is the
wrong length for a buying decision: six paragraphs in a modal is not a comparison, it is a reading assignment, and a
player deciding between the D&H and the C&StL needs the difference between them in the same glance.**
**So the summary lives here, beside the paragraph it summarises, rather than in the modal that renders it. Two
descriptions of one power kept in two files is the arrangement that drifts — and this pair is unusually exposed to it,
because the long text is the one that gets corrected when a rule is found wrong. Together, an edit to one is an edit
in front of the other.**
**Written to be scanned, not to be complete:** it names the hex, says whether the action is free, and says whether it
costs the corporation its ordinary lay — **the three things that decide a purchase.**

### privateCatalog.ts #423 — The acronym is a name, not a number
**Reported:** replace the numeric chips with named acronym pills.
The chips rendered `private_id` — 1 through 6 — **and `#341` defended that: "the cards above are numbered 1-6 and
players refer to these companies by that order ('the 3'), so six chips fit where six names never would."**
**The premise is half true and the conclusion does not follow from it.** Players do say "the 3" **while the auction
cards are on screen and numbered, because the number is a POSITION in a list they are looking at. Away from that list
— in the Ledger's Player Assets table, or two rounds later — `3` names nothing. It is not the company's identity, it
is its rank in a queue that has since been consumed.**
**The acronyms are the identity**, they are what the rulebook and every player use once the auction is over, **and
they are short enough that the width argument never applied: `SV` is two characters against `1`'s one.**
**Why the catalog and not the state:** `PrivateCompanyState.name` carries the full name and **the contract will never
send an abbreviation**, so this is frontend presentation data about a fixed set of six. Keyed by `private_id` **so it
cannot drift from `revenue` and `ability` beside it.**
The lookup returns **`null` rather than a fallback to the number: a caller rendering a pill for an unrecognised
private should decide for itself whether to draw nothing or to degrade, and quietly reintroducing the numeric chip
this replaced is the one answer that should not be automatic.**

---

# Station tokens — `utils/stationTokens.ts`

### stationTokens.ts #0 — The price escalates; it was a constant
Every placement charged a flat $40 — **a stand-in reached for when nothing else about tokens was wired, and never
revisited. 1830's schedule is not flat, and the shape of it is the whole decision a president makes about tokens:**

- **The home token is free.** Granted automatically when the corporation floats, **so it is not bought at all.**
- **The second costs $40.**
- **Every one after that costs $100.**

**So a corporation's third token is two and a half times its second, and the UI was quoting $40 for it. That is not a
rounding error in a readout — it is the difference between a placement a treasury can afford and one it cannot,
presented as though the choice were cheap.**
**`RulesReference.tsx` already carried the correct schedule in prose**, which is worth noting: **the rules screen and
the action button disagreed, and the rules screen was right.**

### stationTokens.ts #1 — The allowance is per corporation, not a constant
`PublicCompanyState.station_token_limit` is the authority **and this file reads it rather than restating 1830's
table.** For reference: PRR/NYC/CPR 4, B&O/C&O/ERIE 3, NNH/B&M 2 — **home token included — which is why "how many can
I still buy" is `limit − 1` slots deep and not a fixed three everywhere.**
The row shows **all of them, placed and unplaced, because it is a picture of the corporation's capacity rather than a
to-do list: seeing that two of four are spent is the point, and a row that dropped the spent ones would shrink as the
game went on and say nothing about what had been used.**

### stationTokens.ts #2 — Three refusals, before a signature
`hexmap::execute_place_station_token` is the authority and rejects anything illegal that reaches it. **What this adds
is the same three refusals BEFORE a transaction is signed, with a sentence saying which one bit — because a click that
silently does nothing, or costs a signature to learn "no", is the failure this file exists to prevent:**

1. **Connectivity.** The city must be one the corporation's own track already reaches. **Shares `reachableNetwork`
   with the tile-lay veil, so the two cannot disagree about where a network ends.**
2. **A free slot.** Every city has a fixed number of token circles; **when they are full the city is closed to new
   tokens (and blocks other companies' trains from running THROUGH it).**
3. **Reservations.** A corporation's home city holds a slot for it from the start. **Until that company floats and
   places its home token, nobody else may take the reservation.**

**It does NOT model the one-token-per-turn rule, the treasury check, or whose turn it is — those are elsewhere in the
UI or on chain, and duplicating them here would be a second opinion.**
**Slot occupancy is named rather than generalised:** a city closed by other companies' tokens **is the single most
consequential board state in 1830 — it blocks their trains from running THROUGH — so the refusal names it rather than
saying "illegal".**
**The reservation is released by USE, not by floating:** a company that has floated AND placed its home token is
**occupying** the slot rather than reserving it, and its token is already counted. **That distinction matters on the
shared OO hexes: ERIE's home is a two-city hex, so before ERIE floats another corporation may still take the OTHER
circle — reserving both would over-block it.**
**Connectivity is checked LAST, deliberately.** The three above are properties of the CITY and are true for everybody;
**this one is about the acting corporation, and a player who has been told "that city is full" does not also need to
be told their track does not reach it.** A corporation with no token yet has no network to measure, **and its first
placement is its home city — which the contract grants at float rather than asking for. Rather than guess, that case
is allowed through and left to the chain.**
Total slot counts come from the laid tile where there is one, **and from the printed cities otherwise — one circle for
an ordinary city, two for an OO pair or New York. A hex with no city has none, which is what makes the "no city here"
refusal fall out of the same lookup.**

### stationTokens.ts #438 — Why this corporation cannot place a station
`null` when it can. **The three blocking conditions are checked in the order a player discovers them — do I have a
token, can I pay for it, is there anywhere to put it — so the reason reported is the first that actually stops them
rather than whichever is cheapest to test.**
**The topological check is the real one, and it reuses the same set the targeting veil lights.** A cheaper
approximation — "does the network touch any city" — **would disagree with the veil about reservations, occupied slots
and OO tiles, and the failure would be the worst kind: a step skipped for a corporation the map would have let place,
or a player held on a step whose veil lights nothing.**
**It is the expensive one too — it walks every board hex — so it runs last, after the two cheap facts have had their
chance to answer.**
**Phrased as a reason, not a boolean.** The caller puts it in an "Auto-Skip — …" log line, **and the three cases call
for different responses: an exhausted allowance is permanent, a short treasury is fixable next turn, and no reachable
slot is a fact about the map that a tile lay might change. A bare `true` would collapse them.**

### stationTokens.ts #453 / #459 / #463 / #580 — Which city node the click landed on
**#453:** a hex can carry more than one city — New York's #54/#62, every OO tile — **and `PlaceStationToken.city_index`
exists precisely so a player can say which. Nothing was answering the question, so every placement omitted the field
and the contract fell back to "lowest-indexed city with a free slot": always legal, and on a two-city hex a coin toss
against what the player actually clicked.**
**How it decides:** each city's slot points are already computed for drawing, **so a city's position is the centroid of
its own slots and the click resolves to the nearest. That reuses the drawing geometry rather than describing the tile a
second time, which is what keeps "where the token appears" and "which city you clicked" from drifting apart.**
**Nearest, with no radius.** A click has already been established as landing inside this hex, **and every point inside
a hex is nearer one of its cities than the other. Adding a hit radius would create dead zones between the cities where
a click inside a legal hex resolved to nothing — a worse answer than the nearest city, and one the player cannot see
the boundary of.**
**`null` for "could not tell", never a defaulted `0`** — an untiled preprinted double city has no per-city geometry,
**and guessing would send a confident wrong index; omitting the field lets the contract apply its documented
fallback.** A one-city tile short-circuits to `0` **without measuring: its index is not a guess, there is only one.**
**#459 — a preprinted OO hex is still two cities.** *Reported:* clicking the upper-right city on the Erie's home tile
places the token on the lower-left one. This bailed to `null` for any hex with **no laid tile**, **true of an ordinary
blank hex and false of the four preprinted OO hexes — E5, D10, E11 and H18 — which arrive with two station circles
already printed. E11 is the Erie's home, so the one hex a new president is guaranteed to click was in the gap.**
**The consequence was silent and looked like a targeting bug rather than a missing branch:** `null` means "I cannot
tell", the caller correctly omits the index, and the contract applies its fallback of the lowest-indexed free city —
**which is 0. So every click on either circle resolved to city 0, and the marker geometry then drew that token at the
bottom-left circle. Two independently reasonable defaults compounding into "the upper-right node does not work".**
Hit-testing now uses **the same tuple the board draws those two circles from, so it cannot disagree with what the
player sees.**
**#463 — the nodes a click can land on.** *Reported:* valid city markers do not glow, so the specific clickable node is
not obvious. **Why this shares the hit-test's geometry, and why that is the whole point rather than mere tidiness: a
glow is a promise about what a click will do. If the glow were drawn from one source of node positions and the
hit-test resolved against another, the two could disagree — and the failure would be the cruellest kind: a marker that
pulses invitingly and then places the token somewhere else.** Both read the same two branches, in the same order.
**#580 — the other half of `#221`.** *Reported:* the placement ring sits in the middle of Baltimore's hex rather than
on its city circle, and is slightly off both of New York's. `#221` fixed exactly this for the marker point **and
described the cause precisely** — preprinted hexes used to draw their city at the hex CENTRE and then began rendering
from authored artwork. **This function was never told.** It is the other answer to "where are this hex's cities", used
by the pulsing rings and the hit-test, **and it kept both of the guesses `#221` removed: `center` for a single city,
and the fixed NE/SW diagonal for two. That diagonal is why New York's rings are close but wrong** — the authored
endpoints and the diagonal **happen to agree in DIRECTION while disagreeing in DISTANCE.**
**Two functions answering one question, one of them fixed — the pattern this codebase keeps finding, and the reason the
fix is to consult the same source rather than to copy the same maths.** The old guesses survive **only as the fallback
for a hex with no authored artwork at all, which is the one case they were ever right about.**

---

# Batch 5C — Auction escrow, the two private-company rules, and the train market

## components/AuctionPromptModal.tsx — the two decisions the auction leaves behind

### AuctionPromptModal.tsx #399 (UI half) — Set the B&O's price, now
**REPORTED:** buying the B&O private must prompt the player to select a par value and award them the President's
Certificate.

**The certificate half already worked** (`grantBOPresidency`). **The prompt half was implicit** — the Stock Round
panel's par ladder shows while `par_value` is null, and `#354` called that the prompt. **That stopped being true:
the B&O is won during the AUCTION, on a different tab and a different round from the ladder, and `#396` has since
hidden every card's controls behind an active-card click. A prompt nobody encounters is not a prompt.**

**SO IT IS A MODAL, AND BLOCKING**, for the same reason the emergency train purchase is: **this is not a decision
the player may defer. Until it is answered the B&O has a president and no price, which `#387` makes a genuinely
unrenderable state — no market token, no market figure, a corporation that exists but cannot be valued.**

**NO DISMISSAL, NO BACKDROP CLOSE.** Every other modal in this codebase can be waved away **because every other
modal is optional. Neither of these has a cancel path because there is no legal state on the other side of
cancelling: the private is already won and the certificate is already owed, and an auction with no companies left
in it is not a round anybody can keep playing.**

**THE LADDER IS THE SAME SIX RUNGS the Stock Round uses, read from one exported constant rather than retyped, so
the price a player may set here can never differ from the price they could set there.**

### AuctionPromptModal.tsx #547 — One card, not two modals in a row
**INSTRUCTED:** "the B&O winner could set the par in their pop-up and then within that same modal have a 'Proceed
to Stock Round 1' button, so that they don't need two modals in a row."

Which is also why **"Proceed" stopped being a button at the foot of the auction panel.** That banner was the last
thing on a scrolling grid of six cards — **exactly where a player who has finished reading stops looking** — and
`#306` had already noticed the deeper version: **"is concluding" is not a state a player can leave, so the round
was waiting on an action nobody could see they had to take.**

**TWO INDEPENDENT SECTIONS, NOT TWO STEPS.** `parPending` and `handoffPending` are separate booleans, each
rendering its own section, **which gets the merge for free and without any internal step state:**

| Case | Renders |
|---|---|
| B&O won mid-auction | par only — **there is no round to hand over yet** |
| Auction ends, no par | handoff only |
| B&O won on the last | **both, in one card.** Confirming the par flips `parPending` false while `handoffPending` stays true, **so the SAME mounted card loses its ladder and keeps its Proceed button. The player sees one modal change, not a second one open.** |

**A step machine would have had to know which of those three it was in, and would have been wrong in the case where
the par is confirmed but the auction still has companies left.**

**WAITING IS RENDERED, NOT HIDDEN.** When somebody else owes the B&O a par price, **the other players get the card
with Proceed disabled and that player named. The alternative — showing them nothing — is a table that has visibly
stopped with no explanation on screen, and the reason it stopped is a fact about another player that only this
modal knows.**

### AuctionPromptModal.tsx #543 — A prize is shown to whoever won it
**REPORTED:** at the end of the auction BOTH players were told they had won the B&O and both could set its par.

**The prompt is raised wherever the winning action is APPLIED, and in a room every client applies every action —
that is the whole design (`#522`). So it was raised on both screens, correctly, and then rendered on both because
the open test asked only whether a prompt existed and not whose it was.**

The identity test **lives in `App.tsx` with the identity** and arrives here already resolved: **`parPending` means
"THIS viewer sets the par", never "a par is outstanding somewhere". `awaitingParFrom` carries the other half for
everybody else.**

---

## utils/auctionEscrow.ts — what a player can still spend

### auctionEscrow.ts #0 — The money was committed and nothing said so
**REPORTED:** placing a bid does not deduct or escrow the cash, so a player can bid money they have already
committed elsewhere.

**True, and visibly so: a player with $600 could stand $400 on the D&H and $400 on the M&H, and every panel on
screen would still read $600.** In 1830 **a bid is CASH ON THE CARD — the note physically leaves your hand and sits
under the certificate until the private is either won by somebody else (refund) or won by you (payment). Two bids
totalling more than you hold is not a rule violation the contract has to catch; it is a move you cannot physically
make.**

### auctionEscrow.ts #1 — Derived, not deducted
**The tempting implementation is to subtract the bid from `player_cash` on dispatch and add it back on a loss.**
`sandboxSession.ts` explicitly declined:

> "A waterfall bid is ESCROWED rather than spent... Charging on the bid and refunding on a loss would be this file
> modelling a rule it has no business owning."

**It is also the fragile version. A deducted balance has to be kept in step with the bid list through every raise,
drop-out, settle, all-pass markdown and UNDO — six places that can each drift**, and `App.tsx #310` is a fresh
reminder of what drift costs. **The bid list already records every commitment; subtracting from it is arithmetic
over state that exists rather than a second copy of the same fact.**

So `player_cash` holds the player's **TOTAL, exactly as the contract reports it**, and available cash is computed
on demand. **A refund is then not an operation at all: when a bid leaves the list — because its bidder dropped out,
or because the private was won and left the offer list with every bid on it — the money is free again on the very
next render, with nothing to remember to do.**

### auctionEscrow.ts #2 — What counts as committed
**Every standing bid on every STILL-UNOWNED private**, which is exactly what `GetWaterfallState.privates` reports.
**Bids on a private that has been won are gone from the response along with the private, which is correct: that
contest is over and the losers' money came back.**

**One bid per player per private is the rule the reducer enforces (a raise REPLACES rather than stacks), so this
sums the list as it stands rather than trying to deduplicate it.**

Available cash is **floored at zero. A negative would mean the state carries bids the player could never have made,
which is a contract-side inconsistency rather than something a UI should render as a negative balance; the floor
keeps the gates behaving (nothing is affordable) without inventing a figure.** `null` propagates from `totalCash`:
**unknown stays unknown.**

### auctionEscrow.ts — the block reason returns a sentence, not a boolean
**A gate that only says "no" makes the player guess which of the two limits they hit, and the two have opposite
remedies: bid more, or drop a bid elsewhere.**

`raisingFrom` is this player's bid already standing in the contest they are raising within. **That money is ALREADY
escrowed, so a raise only needs to cover the difference — charging the full raise against available cash would make
a player who is winning unable to defend their own bid, which is the exact opposite of the position they are in.**

---

## utils/baltimorePrivate.ts #660 — The B&O private has two rules and had neither

**REPORTED:** "the rules prohibit B&O (private company) being sold to a corporation and does not change hands if
the owner loses the Presidency of the B&O (the corporation) ... B&O (private company) closes as soon as B&O
(corporation) purchases its first train, and in my playthrough B&O (corp) has purchased a train and is still
appearing in this modal and the Player card on multiple screens and Player Assets in Game Ledger."

**Both rules were already WRITTEN DOWN, in `privateCatalog.ts`, in this codebase's own words:** *"It can never be
sold to a corporation, and it stays with its owner even if they later lose the B&O presidency. It closes the moment
the B&O buys its first train."* **That text has been on screen in the powers panel the whole time. Nothing enforced
any of it.**

**A rule stated in prose and nowhere else is worse than one not stated at all, because the game teaches the player
a rule and then does not keep it.** Same complaint as the "GAME END" tooltip on a cell that ended nothing (`#652`).

**THE THIRD RULE NEEDS NO CODE.** "It stays with its owner even if they later lose the B&O presidency" is **true by
construction: `owner` is a wallet and nothing in the reducer reassigns a private's owner on a presidency change.
Recorded here so that a later pass adding presidency-transfer side effects finds out that this is deliberate,
rather than discovering it as a gap.**

**WHY A MODULE FOR TWO PREDICATES.** Both answers are needed in three places each — the reducer, the offer list and
the tests — **and the one thing that must not happen is the modal and the reducer disagreeing about whether a sale
is legal. A player offered a purchase the reducer then refuses has been lied to by the UI; a player refused one the
reducer would have allowed has lost a legal move. One source for both.**

**The two B&Os are named as separate constants** (private `#6`, corporation `company_id` 4): **they share a name
and nothing else, which is the whole reason the rules are easy to state and easy to get wrong.**

- **`corporationMayBuyPrivate`** — everything except the B&O, which 1830 forbids outright. **The rule has no
  conditions — not a price, not a phase, not a presidency — so it is a property of the certificate rather than of
  the situation.**
- **`shouldCloseBaoPrivate`** — the test is simply **whether the B&O corporation owns any train at all. Not "did a
  purchase happen", which would need an event; the FLEET is the evidence, and a state whose B&O has a train and
  whose B&O private is open is wrong however it got there.** `owned_trains == null` is **"not reported" rather than
  "no trains"** (the distinction `gamePhase.ts` draws) and returns `false` — **a board we know nothing about must
  not close a company on suspicion.**
- **`settleBaoPrivate`** — returned by identity when nothing changes, **so this can be applied after every action
  without churning references** — the settle pattern `#657` used for `current_global_era`, **and for the same
  reason: the rule is a FUNCTION of the board, so recomputing it means no message can change the fleet and forget
  the closure.** `owner` and `owner_protocol_id` are **released with it**, matching `applyPrivateExchange`
  (`#573a`): **a closed private with an owner still attached shows up in certificate counts and player assets,
  which is half the reported symptom.**
- **`privatePurchaseCertificateBlockReason`** sits **beside** `PrivateTradePanel`'s `privatePurchaseBlockReason`
  rather than replacing it: **that one answers about the SITUATION (unsold, already corporate-owned), this one
  about the CERTIFICATE. Kept apart because a reason that can never change should not be re-evaluated as though it
  might.**

**PHASE 5 CLOSES EVERY PRIVATE and is a different rule with a different trigger; it is not implemented here and
this does not implement it. The B&O's closure is earlier and specific, and the two must not be conflated — a game
that reaches Phase 5 with the B&O still open has a second bug, not this one.** The Phase-5 predicate is **exported
unused by the reducer today, and deliberately: it is the check a future Phase 5 closure needs, and writing it
beside the B&O's own rule is how the two stay distinguishable.**

---

## utils/privateExchange.ts — the private that turns into a share

### privateExchange.ts #573 — A button that says "Used" has to have done something
**REPORTED:** clicking "Exchange for PRR" greyed the button to "Used" and did not grant the share. Same for the
Mohawk & Hudson's NYC exchange.

**Neither ever could.** `handleUsePrivateAbility`'s fallback branch **added the action to `usedPrivateAbilities` and
wrote a log line, and that was the whole implementation** — exactly the failure `#444` records for the D&H's Place
Station button: *"this handler marked the ability spent and wrote a log line. There was no dispatch, no placement
and no navigation — the button reported an action it had not performed."*

The two hex-targeting powers were fixed then. **The two EXCHANGES were left on the fallback, so the same bug
survived in the two places that were hardest to notice: a share arriving silently is easy to miss, and the private
staying in the panel looks like it is merely spent rather than like nothing happened.**

### privateExchange.ts #573a — Exchanged is not spent
**"Used" was also the wrong VOCABULARY**, and the report says so precisely: *"since the private company is
EXCHANGED, it should be removed from the player's Private Powers (not simply 'Used') as well as their
certificates/inventory."*

**The D&H's two powers are spent — the company stays, the ability is gone, and a greyed row is the honest
rendering. An exchange consumes the COMPANY: it is handed back and becomes a share certificate. A closed private
that goes on sitting in the panel greyed out is claiming the player still owns something they traded away, and it
goes on counting toward their certificate total and their assets.**

So **`closed` is set, which every reader already honours** — the panel filters on it, the ledger drops it, and
`playerPrivateCompanies` stops returning it. **One field, and the company leaves every surface at once.**

### privateExchange.ts #573b — A refusal is not a use
**REPORTED**, as a hypothesis: "this might be because the player is already at the ownership limit (60%), but in
that case the Exchange button should return an error that they are at the limit and the power should be maintained
for a subsequent round."

**That is the right shape whatever the cause, and it is the half a mark-it-used implementation can never get right:
the power is not spent by ATTEMPTING it. A player at 60% now may be under it next round, and burning the ability on
a refused click destroys a real asset.**

So **legality is decided BEFORE anything is written**, the reason comes back as a sentence the panel can show, and
**nothing is marked on a refusal.** The predicate is **PURE and separate from the state change on purpose: the
panel wants the reason on a disabled button BEFORE the click, and the dispatch wants the same answer at the moment
it fires. One function asked twice cannot drift the way a disabled-check and a guard would.**

### privateExchange.ts #576 — The Camden & Amboy was never an exchange
**REPORTED:** "Private Company 5 is supposed to come with a 10% share of a corporation; however, the winner of that
auction does not receive anything."

**Correct, and this table was mine and wrong.** The previous pass built the exchange machinery for **BOTH** the
Mohawk & Hudson and the Camden & Amboy, on the strength of `PrivatePowerPanel #350`.

**`privateCatalog.ts` said the opposite, in a line THIS SAME AUTHOR had rewritten two passes earlier (`#548`):**
*"Whoever buys it out of the auction is handed a 10% PRR share at once and at no further cost. Nothing is triggered
and the company stays open."* **That is 1830's actual rule**, and `#360` had recorded it explicitly as one of four
things an older paraphrase got wrong: *"C&A was described as an ability the owner triggers. It is not: the share
arrives on PURCHASE and the private stays open."*

**So the fact existed in two places, the two disagreed, and the build followed the wrong one — the TD-1 failure
this codebase keeps recording, committed while writing a note about it.** Two consequences: **the share never
arrived** (the panel's button was in a round the auction had already left), **and had it ever fired it would have
CLOSED a company 1830 keeps open and paying $25 a round.**

**ONE ENTRY NOW.** The M&H genuinely is an exchange — the player trades the company away for the certificate, and
it closes. **The C&A is a purchase bonus and is granted where the auction resolves, not from a button.**
`keepOpen` marks it: **closing it would cost its owner $25 an Operating Round for the rest of the game.**

---

## components/PrivateCompanyPills.tsx #423 (UI half) — Named pills, not numbered chips

**REPORTED:** replace the generic numerical chips for private companies with named acronym pills, laid out
horizontally so row height is preserved, and make them clickable to reveal their full rules text inline. Wanted in
both the auction's seating table and the Ledger's Player Assets table.

See `privateCatalog.ts #423` for why `1`..`6` was never the company's identity.

**WHY ONE COMPONENT FOR TWO TABLES.** The two surfaces had independently-grown chip renderers — the auction's
`seatingPrivateChip` and the Ledger's `holdingChipPrivate` — **which is how they came to disagree about what a
private looks like in the first place (one showed a number, the other a full name and a revenue figure). A third
hand-rolled pill would have been the third opinion.** The two callers differ only in `surface`.

**ROW HEIGHT IS THE CONSTRAINT, AND IT IS WHY EXPANSION GOES BELOW.** Both tables are dense and **both have already
been bitten by a cell that grows** — the auction's `seatingPrivates` carries a fixed `0 0 128px` basis **precisely
so a player winning their first private cannot shove the columns sideways (`#341`)**, and `#323` reserves the turn
slot for the same reason.

So the pills **never wrap and never grow: they scroll horizontally within their cell** (`overflowX: auto` rather
than `hidden` — **a player holding more privates than the cell can show must still be able to reach them, and a
scrollbar in a 128px cell is a better answer than a hidden asset**). **The rules text opens BELOW the pill row
rather than beside it, where it can take the height it needs without moving any neighbouring column.**

**ONE OPEN AT A TIME, per component instance. Two open panels in a table row is a row that has become a paragraph,
and the question a player asks here is about one company at a time.**

**A BUTTON, NOT A DIV WITH AN ONCLICK.** These are interactive **and they are in a table, which is exactly the
combination where a `div` with a click handler becomes unreachable by keyboard and invisible to a screen reader.**
`<button>` gets focus, Enter and Space for free, and `aria-expanded` tells a reader what the press will do. **The
`title` stays for the hover case but is no longer the only way to get the information — which was the real
limitation of the chips this replaces: their full name lived exclusively in a tooltip.**

An id outside the six yields `null` and **the pill falls back to the full NAME rather than to the number this
component exists to remove. An unrecognised private is a data problem; showing its name is the most useful thing to
do about it and the least likely to be mistaken for a working acronym.**

---

## components/TrainTradePanel.tsx — corporation-to-corporation train sales (Audit G-15)

1. **THREE AUDIENCES, ONE PANEL.** Every offer is visible to everyone, **but what you can DO with it depends on
   which president you are:** the SELLER's president sees Accept / Reject; the BUYER's president sees Rescind;
   anyone else sees a read-only row. The backend resolves both presidents onto each offer
   (`TrainOfferEntry.seller_president` / `buyer_president`) **precisely so this decision needs no cross-referencing
   of the company list here.**
   **Read-only rows are shown rather than hidden on purpose. A pending offer is public information at the table —
   everyone can see two players negotiating — and hiding it would make the blocked turn inexplicable to the other
   players waiting on it.**
2. **THE BLOCKED TURN IS THE HEADLINE.** While a corporation has an offer outstanding it cannot end its OR turn.
   **That is enforced on-chain (`operations::PendingTrainOfferBlocksTurn`), so if this panel said nothing the player
   would simply find "End Turn" failing with an error and no visible cause.** The banner states the block and puts
   Rescind next to it, **because rescinding is the one thing that clears it and it is entirely in the buyer's
   hands.**
3. **SAME-PRESIDENT SALES NEVER APPEAR HERE.** If one player is president of both corporations **the contract
   settles immediately and writes no offer, so there is nothing to display.** The compose form still shows those
   corporations as sellers — **the sale just completes on submit instead of creating a row. The form says so, rather
   than letting the difference surprise the player after they click.**
4. **PRICES ARE STRINGS ALL THE WAY THROUGH.** `price` is `Uint128` on-chain and arrives as a JSON string. **The
   input is validated as a non-negative integer string and passed on unparsed — the same no-float discipline the
   contract holds itself to. A price above 2^53 is not realistic, but parsing to `Number` here would be a silent
   precision bug for no benefit whatsoever.**
5. **UNAVAILABLE MODELS ARE DISABLED, NOT HIDDEN, and carry counts.** A corporation that owns no 4-train shows
   "4-train — none owned", greyed. **Hiding the row would leave the player wondering whether the model exists at
   all; showing it greyed answers "can I buy a 4-train from them" with a definite no.** Models the seller DOES own
   show how many, **because two 2-trains and one 2-train are different negotiating positions.**

### TrainTradePanel.tsx #6 — The compose form moved, the ledger stayed
`TrainPurchasePanel` now owns composing an offer (**a clickable roster of real train badges replaced three
dropdowns**). What it does **NOT** own is the OFFER LEDGER: the blocked-turn banner, the pending rows and the
three-audience split.

**Two panels rendering two compose forms for one action would be the classic duplicate-control bug**, so this is
**switched off at the call site rather than deleted. Kept switchable rather than removed because the form is the
only surface that works against a chain predating `owned_trains` — the badge roster has nothing to render there,
and a build pointed at such a contract can turn this back on in one prop.**

**`owned_trains` `undefined` means the CHAIN DID NOT SAY, which is emphatically not "owns nothing".** In that case
**every model stays selectable and the contract remains the authority; greying everything out against an older
chain would make trading look broken rather than unsupported.** Duplicates in the model list **are meaningful and
drive the "(2 available)" counts.**

---

## components/TrainBadges.tsx — chips, capacity and payout

### TrainBadges.tsx #0 — Shared because the Rust rule must not fork
These started inside `ContextualSubPanel.tsx`. The Stock Round card front now needs the same three readouts, and
**copying them would have duplicated the part that is easy to get subtly wrong: which tier is vulnerable, and how
loud the warning should be. A second copy that drifted by one phase would show a player green chips on trains that
rust on the very next purchase.**

So the rule lives once, reading `GamePhase` (`utils/gamePhase.ts`). **Both callers pass the same derived phase
object and get the same answer by construction rather than by discipline.**

### TrainBadges.tsx #1 — Two surfaces, because this app has two
The OR table sits on dark chrome (`#1b2130`-ish); the Stock Round cards are linen white (`CARD_SURFACE`,
`#f7f5f0`). **A single chip palette cannot serve both — the dark chip's `#232936` fill on a white card reads as a
hole punched in the paper.**

`surface` is a **REQUIRED prop rather than one defaulting to `"dark"`. A caller that forgets it should fail to
compile, not render invisible text on the surface the default did not anticipate.**

### TrainBadges.tsx #2 — Colour means one thing each

| Colour | Meaning |
|---|---|
| amber/orange | this train tier rusts in **two** more purchases |
| red/crimson | this train tier rusts on the **very next** purchase |
| purple | this corporation is at its **train limit** |

**Purple for the capacity pill specifically because the first two are warnings about DESTRUCTION and the third is a
statement about CAPACITY. The pill was briefly amber, which put "you are full" in the same colour as "your trains
are about to be destroyed" — two unrelated facts, one signal, sitting in adjacent columns of the same row.**

### TrainBadges.tsx #4 — Every chip says something, and the counts agree
**Two different questions a chip can answer, and it used to answer neither for most tiers:**

- **ESCALATION (colour)** — am I in the danger window right now? **Amber at one train left in the current depot
  tier, red at zero. Deliberately driven by the DEPOT rather than the tier, so the warning does not shout from the
  moment a phase begins.**
- **OUTLOOK (tooltip)** — what will eventually destroy this train, and how far off is it? **Every tier gets this,
  including permanent ones, which say so plainly. A 5-train with no tooltip is indistinguishable from a 5-train
  whose tooltip failed to load.**

The counts come from `rustOutlook`, **which the action bar's phase tag also reads (`gamePhase.ts #5`/`#6`). That
shared source is the fix for the mismatch this pass was raised for: the tag claimed "next buy" while the chip said
two purchases, and the chip was right.**

Severity comes from **the SHARED countdown, not from a second reading of `depotRemaining`** (`gamePhase.ts #7`) —
same two thresholds as before, **but the action bar now reads the identical helper, so the chip and the badge
cannot escalate at different moments.** **Amber became ORANGE here specifically because amber is already spent
twice over — on "look here" and on the Yellow ERA — which made an amber rust warning during the Yellow phase
near-invisible against the phase badge sitting beside it.**

### TrainBadges.tsx #3 — The empty and unknown states are chips too
These used to be bare text while the populated state rendered pills, **so an unfloated corporation's row read as
plain words sitting next to a floated one's badges — the two looked like different KINDS of readout rather than the
same readout with different contents.** Same chip shell, muted ink, **so a column of cards lines up whatever each
holds.** `undefined`/`null` `owned_trains` means **UNKNOWN — a contract predating the field — and renders "?",
never "none".** The prop is `readonly` **because requiring a mutable array forced callers holding a frozen roster
to copy or cast — a widening of the type, not a loosening of it.**

### TrainBadges.tsx #375 — A chip is a train, and a train runs a route
**THE INDEX IS THE POSITION IN `trains`**, the same key the Route Planner's rows and the map overlays use.
`RoutePlannerPanel #5` established that **two 3-trains are two different trains and get two rows; this is the other
half — two 3-trains are two different chips and highlight independently.**

**ALL THREE CURSOR PROPS OPTIONAL, because this component renders in four places and only one of them — the OR
corporation strip during Run Routes — has a cursor to share. The Round Detail table and the depot want a chip that
does nothing on hover, and forcing them to pass nulls would be plumbing a feature they do not have.**

### TrainBadges.tsx — `last_route_revenue` is now live
The comment that stood here said it was *"ALWAYS `undefined` TODAY... no query returns it and there is no field to
reconstruct it from"*, **and that was true when written. The contract since gained `last_route_revenue`, written on
every route run and returned by `GetGameState`.**

**`undefined` still has a distinct meaning and is still rendered differently: it is what a contract predating the
field returns, i.e. "this build cannot tell you". A real `"0"` means the corporation ran and earned nothing, which
is a fact rather than an absence.**

### TrainBadges.tsx #370 — A chip's height was font metrics, not a number
**REPORTED:** the train chips in the Corporation card are clipped at the bottom.

**The chip had no height of its own.** Its box came out of `lineHeight: 1.25` on the inherited font — **15px × 1.25
= 18.75px — plus 2px padding and a 1px border each side, so 24.75px.** Three things then conspire:

- **IT IS FRACTIONAL.** A 24.75px box on a display that snaps to device pixels rounds, **and which way it rounds
  depends on the zoom and the element's subpixel offset. Round down and the 1px bottom border — the curved part of
  a 5px radius — is the row that goes.**
- **`inline-flex` SITS ON A BASELINE.** The chip row is an inline-level box inside a text flow, aligned by the
  baseline of its first item, **so its descent has to fit under the baseline in whatever line box the parent built
  from the SAME font metrics. A chip taller than its own line box overhangs.**
- **THE CARD HAD 3px TO GIVE.** `#299` cut `orContextCard`'s vertical padding to 3px and removed its 44px floor —
  **correct for the space it reclaimed, and it left nothing absorbing the overhang.**

**`minHeight` states the box in whole pixels instead of deriving it from a font, and `alignSelf: flex-start` stops
the baseline alignment stretching it.** `App.tsx #371` gives the card back the two pixels the row needs. **Both
halves: an unclipped chip in a card too short for it is still clipped.**
