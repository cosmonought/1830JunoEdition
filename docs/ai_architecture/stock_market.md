# Stock Market — Par, Pricing, Chart Moves

Par value selection, IPO vs bank-pool pricing, market chart marks and moves, and the Stock Round
corporation cards.

Anchors are `<source file> #<N>`. Search the number.

---

## Par values

### App.tsx #398 — One par selection per corporation
**Reported:** selecting a par value on one corporation's tile updates the par selector for all
corporations, and for all players.

The cause is the shape of the state, not the cards: `srParValue` was **one string**, threaded into
all eight ladders as `parValue` and back out through one `onSelectParValue`. Every ladder was a view
of the same value, so pressing $90 on the PRR moved the highlight on the B&O — and because the
dispatch read that single value, the **next** president's purchase carried a price somebody else had
chosen for a different company.

This is precisely the bug `StockRoundPanel.tsx #18` fixed for the buy **source**, which was also one
value shared across eight cards: "the toggle a player set on PRR silently governed the purchase they
then made from B&M." Par is the same failure with worse consequences, because par is not a
preference — it is the price the certificate is bought at, set once and permanently.

- **Keyed by `company_id`, not by index.** The roster's order is the contract's and a company can be
  absent from a partial response, so an index would silently re-point one company's par at another's.
- **The default is not stored.** A company with no entry falls back to `MOCK_BUY_STOCK_PAR_VALUE` at
  read time, so the map holds only genuine choices — which keeps "has this player picked a par for
  this company" answerable.
- **"And for all players"** is the same single-value bug from the other side: the map is cleared when
  the acting seat changes, so an incoming player never inherits the outgoing player's half-made
  choice — otherwise they would buy a president's certificate at a price they never picked. Same
  trigger `StockRoundPanel` uses to drop its active card.

### App.tsx #579 — The ladder stops here
`parValueNumberFor` read **this browser's** par ladder and fell through to a hardcoded `"100"` on
every client that did not make the choice, and the reducer preferred it over the message — which is
how a corporation parred at $67 came to be recorded at $100 by every client but its founder.

The message's own `par_value` is what the reducer reads now. `parValueNumberFor` is **deleted**
rather than left unused: a helper that returns a plausible par from local state is exactly what
someone reaches for next time.

### App.tsx #553 — The merged state, synchronously, for the par resolvers
`sandboxStateRef` alone would be right in the sandbox and blind on a live chain, where the
corporation's par arrives from the poll — and a par resolver that works in one mode and silently
falls back to $100 in the other is `#579`'s exact failure reintroduced in a narrower place.

A ref rather than a dependency for `#536`'s reason: these resolvers are read inside
`runGameplayAction`'s context, whose identity two **dispatching** effects key on.

**Written during render, deliberately not in an effect** — the opposite of what `#546` does one
screen away, so the difference is worth stating. That ref holds a **callback** read later from an
event; an effect keeps it from holding one belonging to a render React discarded. This one is read
**during the same render**, by `parValueFor`, to price a button. Deferring it would make the button
show the previous par for one render — and since `parValueFor`'s identity would not have changed,
nothing would schedule the re-render that corrected it. The assignment is idempotent, so a double
render in StrictMode writes the same value twice.

### App.tsx #351 / #398 (dispatch) — Read for the company in this message
The protocol id comes off `msg` rather than from any ambient selection, because the message is the
only thing that knows which company this particular dispatch is about. Read from the **ref** rather
than the state variable for `#265`'s reason — within one dispatch the state may still be a render
behind, and a par set from a stale selection would be the wrong price forever.

### App.tsx #399 — The B&O private owes its winner a presidency AND a price
Held in a prompt until answered, because the certificate must not be granted without one. The grant
needs a par price, the price is the winner's to choose, and choosing it is a decision — so the win
raises a prompt and the grant happens when the prompt is answered. Granting first and pricing later
produced a presided-over company with no price, which `#387` correctly refuses to draw.

*(See `firebase_middleware.md` `#565` for why the prompt asks the board rather than a latch, and
`#550` for why the grant travels through the log.)*

---

## IPO vs bank pool

### App.tsx #558 — The source decides the price, not the float
This read the corporation's `is_floated` and, once true, sent `par_value: null` — "price this at
market". The comment defended it as matching `BuyStock`'s real semantics; it does not match 1830's.

**In 1830 the IPO always sells at PAR**, for the whole life of the corporation, until the IPO is
empty. The stock market price governs the **bank pool**. They are different piles of shares at
different prices and a player chooses between them every turn — which is most of what makes a Stock
Round interesting, and it collapses entirely if floating silently repoints the IPO at the market.

The consequence is not cosmetic: a corporation whose price has run up would sell its remaining IPO
shares at the higher figure, so the treasury it never receives and the player's cash both move by the
wrong amount, and the error compounds for the rest of the game.

**Floating still matters, just not here:** it releases the treasury (`#134`) and puts the corporation
into the operating order. What it does not do is change where an IPO share gets its price.

So the IPO is priced at par, always; the bank pool takes `null` and is priced from the Stock Market
Matrix, which is the one case that field was ever meant to signal.

---

## Buying and selling

### App.tsx #29 — The target company is an argument
Both handlers used to read `srSelectedProtocolId` — a single "which company is selected" value,
correct while the Stock Round had exactly one set of controls fed by a pill selector.

Permanently expanding the corporation cards breaks that: there are now **eight live Buy buttons and
eight live Sell buttons on screen at once**. Reading a shared selection would mean clicking Buy inside
the B&M card bought PRR — silently, with a perfectly successful transaction, and no way to tell from
the UI until the roster refreshed.

Setting the selection on click and then dispatching does **not** fix it: `setState` is asynchronous,
so the handler would still read the previous value on the click that mattered. **So the company id is
a parameter**, and it travels with the click that produced it.

`srSelectedProtocolId` is therefore **gone**. Keeping a shared selection alongside eight per-card
actions would be a second, contradictory answer to "which company?" waiting to be read by mistake.

### App.tsx #42 — Multi-buy is N transactions, not a batch
The Brown zone lets a player take several bank-pool shares in one turn (`StockRoundPanel.tsx #33`).
`ExecuteMsg::BuyStock` has no quantity parameter, so "buy 3" is three sequential `BuyStock` messages.

**Sequential, stopping at the first failure.** `runGameplayAction` awaits each broadcast, so purchase
N+1 is only attempted once N has been accepted on chain. Firing them in parallel would race the
contract's own pool accounting and could leave the player having bought fewer shares than the log
claims. Each purchase is its own log entry, which is accurate rather than noisy — it really is three
purchases.

A batched `BuyStock { quantity }` would make this one signature and one atomic state change, and is
worth raising in the contract audit. Until then this is the honest shape of the operation, not a
workaround pretending to be atomic.

### App.tsx #490 — The forced sale dispatches the ordinary message
`SellStock` with the block the modal has already validated against both restrictions. The legality
lives in `endgame.ts`, so what reaches the reducer is a sale that was legal at the moment the button
was drawn.

---

## The market chart

### App.tsx #272 — The chart is the third sandbox atom
It used to be a frozen `useMemo` over the fixture table, so no trade could ever move a token. State
now, advanced by `applySandboxMarketAction` on the same dispatch that advances the other two, with
the same ref treatment for `#265`'s reason — a loop of dispatches must see each other's results.

### App.tsx #247 — One chart, derived from one corporations table
In sandbox the chart is derived from the same corporations table the Stock Round cards read, so the
two can no longer disagree. `MOCK_MARKET_GRID` remains only for the non-sandbox placeholder path —
illustrative data never produced by a live query.

`#516`: the roster's price reads the **live atom**, not the frozen `SANDBOX_MARKET_PRICES` constant.
That drift is exactly what `sandboxState.ts #2` exists to prevent — a card saying $76 beside a token
sitting on $71. A live game passes `undefined` and the roster renders a dash, which is honest about
not knowing rather than inventing a price.

### App.tsx #411 — Read the ref, not the memo
One corporation's current chart price, for building the Operating Round queue. `runGameplayAction`
refreshes `sandboxMarketRef` partway through a dispatch and then advances the game state; a lookup
closed over `sandboxMarketPrices` would be a render behind at exactly that moment and could order the
queue on prices the same dispatch had already changed. Stable identity, so it does not re-arm every
consumer on each market tick.

**App.tsx #646 / App.tsx #647**: the operating-order tie-breaks read the same ref for the same reason — the chart is a
separate atom and the queue is rebuilt within a dispatch that may have just moved a marker.

**App.tsx #316**: the ref is written too, because `beginOperatingRound` reads prices through
`marketPriceForCompany`, and the Stock Round close that opens the OR runs in the **same dispatch**
before React has committed the state.

### App.tsx #401 — A par sets a price, and a price is a cell on the chart
Diffed beside the float announcement and for the same reason — the market atom is separate state, so
the shell is what can write to both.

### App.tsx #461 / #468 — The mark is set outside the updater
A par set through the auction prompt does not pass through `runGameplayAction`, so the diff that
normally creates a market mark never sees it (`#399` made this a prompt precisely because the auction
has no `ExecuteMsg` for it). The mark therefore has to be written here too.

**But not inside `setSandboxState`'s updater**, which is where a first cut put it. A state updater
must be **pure**: React may invoke it more than once for a single update (deliberately, in
StrictMode), and calling another setter from inside one is a side effect in a function contracted not
to have any. `placeParMark` is idempotent so the symptom would have been subtle rather than loud,
which is worse — it would have looked correct until some unrelated render made it run at a different
moment. `sandboxStateRef` already carries the current state synchronously (`#265`), so both atoms are
written from one place.

### App.tsx #468 — Floating is also a moment to check
**Reported (critical):** when the B&O floats in a Stock Round — having parred back in the Auction —
its token never reaches the market matrix, and the OR queue that sorts on market price then breaks
the round transition.

The diff watched **one** transition: `par_value` going from null to set. That is the only moment a par
is established for seven of the eight corporations, because their par is set by `BuyStock`, which
dispatches through this path. **The B&O's is not** — its par is set by answering the auction prompt
(`#399`), which writes state directly. The Par Tray reads `par_value` off the game document and showed
the company; the matrix reads the market atom and had never been told.

**So the invariant is enforced at float, not only at par:** a floated corporation must have a market
position, and that has to hold no matter which code path set the par.

**Idempotent by construction** — `placeParMark` returns the same object when a mark already exists,
so the ordinary case passes through untouched and no token is ever dragged back to par after walking.

### App.tsx #434 — The cell was in hand and was being thrown away
**Reported:** withholding on a $67 corporation moved its token to $60 — a cell it was never on — and
the token then vanished from the matrix.

`marketGrid.positions` carries `(x, y, price)` per corporation. The code read that entry, kept
**only the price**, and handed the bare number to `projectDividendMove`, which had to find a cell
again by searching `PRICE_GRID` for that price. The chart repeats prices across rows and the search
returns the **first** match, so a token correctly parked in the $67 par box at `(6, 5)` was projected
from `(1, 10)` — the $67 in the top row — and one step left of that is `(0, 10)`, which is $60.

**The coordinates were never ambiguous; they were discarded one line before the code that needed
them.**

Same family as `#415`, worth naming as such: that was `marketCellForPrice` resolving a **par** to the
wrong cell, this is the same first-match search resolving a **move** from the wrong cell. Both come
from treating a price as an address on a board where it is not one.

The projection carries the cell through, so the readout, the action log and the token all step from
the coordinate the marker is actually standing on — all three now use `projectDividendCellMove`,
which the token move already used. That is why the token appeared to disagree with its own preview:
it was the only one of the three doing it correctly.

### App.tsx #435 (market move label) — Say what actually moved it
This read "fell from $X to $Y on the sale" for **every** move, so a withheld dividend — the most
common way a price falls in 1830, and the one a new president is most confused by — was reported as a
share sale that never happened. The direction is derived too: a payout **rises**, and "fell" was wrong
for it in the same sentence.

### App.tsx #530 — The par track shows parred-but-unfloated companies
The par track is fed by `par_value`, which the contract sets when the President's Certificate is
bought — so a parred but unfloated company appears on the track, which is the whole point of it.

---

## Stock Round layout

### App.tsx #563 — The players, as cards
Below the corporation cards, in the same grid language. The Ledger's Player Assets **table** is
untouched — two views of one dataset, each shaped for its own screen. **Seat-driven rounds only**: an
Operating Round's turn belongs to a corporation, and a row of player portfolios there would answer a
question nobody on that screen is asking.

`PlayerFinances` is computed one per seat in seating order, recomputed when the board or the chart
moves — exactly when a player's position can have changed — and memoised because `sellableHoldings`
walks every corporation for every player, so a naive recompute is six passes over the roster per
keystroke in the chat box.

### App.tsx #602 — The third attempt at "the auction has no cards"
**Reported, again:** make sure the Player cards from the Stock Round show up in the bottom panel of
the Auction round as well.

Twice before, the guard was widened and the cards still did not appear. `#571` added the tab test;
`#597d` corrected it to `surfaceTabFor` so it would resolve to `phase` in an auction. **Both were
right about the condition and both changed nothing, because the condition was never what was
failing.**

**The section was inside the wrong half of a ternary.** The workspace renders
`isWaterfallPhase && activeMainTab === "phase" ? <auction dashboard> : <everything else>`, and the
cards sat in the **else** arm. So during an auction on the phase tab — the exact case being tuned for
— the whole arm was skipped and the guard was never evaluated. A correct condition on an unmounted
subtree.

**Why this is easy to miss:** the two guards read as though they compose.
`surfaceTabFor("WaterfallAuction") === "phase"` and the ternary tests `activeMainTab === "phase"`, so
the inner guard looks like it **agrees** with the branch it is in when it in fact contradicts it.

The panel is hoisted out of both arms, and each arm places it where that round wants it. **One
definition, one guard, two mount points.** A copy per branch would have been fewer moving parts today
and would drift the first time somebody edited only the one they were looking at.

### App.tsx #604 — Handed in, not hung underneath
`#602` mounted the cards as a **sibling** of the dashboard, which put them below it and left the
empty seating panel between the private company cards and them. Both problems are the same problem:
from outside, the only position available is "after the whole dashboard", and the place the cards
belong is inside it. So the dashboard takes the node and places it, in the slot the seating table
used to occupy — the same conduit pattern as `seatOrderTrail` on the action bar. The child owns the
layout, the shell owns the content.
