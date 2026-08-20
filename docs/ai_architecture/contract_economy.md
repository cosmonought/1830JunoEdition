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
