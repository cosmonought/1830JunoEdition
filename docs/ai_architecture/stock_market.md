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

---

# The Stock Market Chart — `StockMarketRenderer.tsx`

Renders `QueryMsg::GetMarketGrid` (`MarketGridResponse` / `MarketPositionEntry`) as the 1830 price
matrix. Sibling to `HexGridRenderer.tsx`; the two are composed in `App.tsx`'s tabbed board view.

## The board data

### StockMarketRenderer.tsx #1 — The chart is a sourced mask, not a formula
`REAL_MARKET_ROWS` is a **byte-for-byte mirror of `market::REAL_MARKET_ROWS`** (Rust), both sourced
verbatim from the 18xx.games engine's `lib/engine/game/g_1830/game.rb` `MARKET` constant and
`lib/engine/share_price.rb`'s `SharePrice::TYPE_MAP` zone legend (cross-checked across two mirrors).

- An earlier pass deliberately kept the frontend on the backend's old `100 + x*10 + y*20` formula so
  the display could not disagree with what the chain stored. That constraint died when `market.rs`
  migrated to the real board data; both sides now render the same **sourced** table, not the same
  formula.
- `buildPriceGrid` **walks the hardcoded 2D array cell by cell**. There is no rectangular x/y loop,
  because the real board is jagged: 19 columns at the top narrowing to 4 at the bottom.
- Coordinate convention: `y` counts **up from the bottom**. `y = 10` is the Ruby array's index 0
  (topmost, highest price); `y = 0` is index 10. The renderer inverts with `gridRow: 11 - cell.y`.
- `MARKET_MIN_X..MAX_X` / `MIN_Y..MAX_Y` (19 × 11) is the **backend's** coordinate contract. It is
  used only to clamp occupant placement — never to decide the visible shape, which is
  `REAL_MARKET_ROWS`'s job.

### StockMarketRenderer.tsx #2 — DOM/CSS grid, not canvas
`HexGridRenderer` uses `<canvas>` because a pannable/zoomable hex map benefits from it. This matrix
is a dense table of small text labels with no pan/zoom/rotation requirement, so a CSS grid of real
DOM nodes wins: text stays crisp at any zoom, ticker badges are ordinary elements, and tooltips are
native `title` attributes rather than hand-drawn overlays.

### StockMarketRenderer.tsx #3 — The zones are cumulative, and that is this project's reading
Every real cell carries a `zoneType` (`Yellow | Orange | Brown | Normal`) mirroring `state.rs`'s
`ZoneType` and `market.rs`'s per-cell assignments. **This project treats the zones as CUMULATIVE**:
Orange implies the Yellow certificate-limit exemption on top of the ownership-cap waiver; Brown
implies both Orange rules plus multiple bank-pool buys. That is the standard physical-rulebook
reading, **not** a literal transcription of the source engine's single-letter tag — verbatim source
note: real `b`-tagged cells are never also tagged `o` in the fetched array.

### StockMarketRenderer.tsx #4 — The par boxes are at their true board coordinates
The six standard par values (`$67/$71/$76/$82/$90/$100`) sit on the real board in a **vertical
column at `x = 6`, spanning `y = 5..10`** — mirroring `market::PAR_VALUE_LADDER`. There is no
separate par-track cluster in the matrix; the six cells are labeled in place.
**Placement is sourced, not chosen for appearance.** `x = 6` of `0..18` is left-of-centre, not the
rightmost column. Relocating them to whichever column looks "rightmost" would silently disagree with
the backend's `PAR_VALUE_LADDER` and reintroduce the displayed-vs-actual mismatch this refactor
exists to eliminate.

### StockMarketRenderer.tsx #43 / #43a — A cliff is a property of the ROW, and only if there is somewhere to go
`REAL_MARKET_ROWS` is jagged, so a **row's own first and last cells are its cliffs**; comparing
against a global min/max x would mark almost nothing.
**#43a:** a left cliff redirects a leftward move *downward*, so it is only a cliff if a cell exists
below it. The `$10` floor at the bottom-left has nothing beneath it and cannot move, so it gets no
arrow; same in mirror for the right cliff and the `$350` ceiling, which has no row above.
Derived from the grid rather than hardcoding `$10`/`$350`: the two terminal prices are a
**consequence** of the board's shape, and a hardcoded pair would silently stop matching if the board
were re-cut.
The cliff arrow is absolutely positioned in the cell's top-right corner so it never displaces the
price text, which is dynamically sized off the measured cell and would reflow if a sibling took
width.

## Resolving a price to a cell

### StockMarketRenderer.tsx #415 — The par box is a coordinate, not a price match
**Reported:** parred corporations put their token on the wrong market cell, or do not appear at all.

Parring does not mean "put the marker on some cell showing this number." It means "put the marker in
the **par box** for this value" — a specific printed cell in the ladder column at `x = 6`.

`marketCellForPrice` returns the **first** match walking `REAL_MARKET_ROWS` in order. Real 1830
charts repeat prices across rows, and every one of the six par prices also appears in the **top row**
(`y = 10`), which is listed first:

| par | `marketCellForPrice` returns | the par box is |
|---|---|---|
| $67 | (1, 10) | (6, 5) |
| $71 | (2, 10) | (6, 6) |
| $76 | (3, 10) | (6, 7) |
| $82 | (4, 10) | (6, 8) |
| $90 | (5, 10) | (6, 9) |
| $100 | (6, 10) | (6, 10) ← agrees by coincidence |

Five of six landed in the wrong cell and the sixth was right by accident — the **worst possible
distribution**, because $100 is the par a developer reaches for when checking whether parring works.

`parBoxCellFor` is the reader for a par. It returns `null` for a non-par price and deliberately does
**not** fall back to `marketCellForPrice`: a price not on the ladder is not a par, and quietly
resolving it to some other cell is exactly the behaviour this function exists to end.
`marketCellForPrice` survives for the case it is correct for — resolving a price the marker has
**walked** to, where any cell carrying that price is as good as any other because the caller has
already lost the real one. It returns `null` off the chart, which callers must treat as "not on the
chart" rather than coercing to the origin: `(0, 0)` is a real cell and a marker parked there is a
visible lie.
`marketCellForPrice` is **exported for the Offline Sandbox** (`#16`), which must produce a
`MarketGridResponse` — a position is `(x, y)`, not a price. Without it the sandbox hand-wrote grid
coordinates separately from the prices on its corporation cards and the two promptly disagreed (PRR
read 112 on its card and sat on the 100 cell).

### StockMarketRenderer.tsx #14 (helper deletion) — `isRealMarketCell` removed rather than silenced
It answered "is `(x, y)` a coordinate this board has", and nothing had called it since `#43a` moved
that question inside `buildPriceGrid` (which precomputes an `occupied` set for the cliff logic).
Removed rather than disabled with a lint comment: a second implementation of "which cells exist" is
the near-miss duplicate class `#428` spent a file consolidating, and an unused export is how the
second copy gets adopted. `cellAt` is the live way to ask — it returns the cell, so a caller needing
the price or zone does not look it up twice.

## Projecting a move

### StockMarketRenderer.tsx #187 — Projecting the dividend move  *[superseded by #434]*
The Dividends step asks pay-or-withhold, and in 1830 that choice **moves the token**: right along the
row on a pay, left on a withhold. The panel offered two buttons and said nothing about the
consequence, which is most of what the decision turns on. `PRICE_GRID` is the real chart, so the
destination is a lookup, not an estimate.
**Scope, stated because the omission is deliberate:** this models the two *ordinary* moves. It does
**not** model ledges, the right cliff, or the end-of-Stock-Round sold-out rise — `market.rs`
implements those and they depend on state this function is not given. Where a step would leave the
chart the projection reports the price unchanged (a clamp), which is never worse than inventing a
cell. **The contract remains the authority on where the token actually lands.**

### StockMarketRenderer.tsx #434 — Projected from a cell, not from a price
Replaces `projectDividendMove(price, choice)`. Reported as "withholding moved $67 to $60": the chart
repeats prices, `$67` appears at `(1, 10)` and at `(6, 5)`, and `find` returns the first. A
corporation in its par box was projected from the top row — one step left of `(1, 10)` is `(0, 10)` =
$60, where one step left of `(6, 5)` is `(5, 5)` = $65.

**The old signature could not be fixed, only replaced.** A price does not identify a cell on this
board, so any function taking one has to guess. Deleting it rather than leaving it beside the
replacement is deliberate — it is the strictly more convenient call, and a caller reaching for the
shorter argument list is how the guess returns.
Takes a **nullable entry** so callers can hand it a `MarketPositionEntry` lookup directly; both call
sites had one and were discarding the coordinates. **Clamps at the edge** — where the step would
leave the chart the marker stays and `moves` is `false`, never an invented cell, which is the other
half of "tokens disappear off the matrix".

### StockMarketRenderer.tsx (share sale move) — One row DOWN per 10% block, and DOWN is `y - 1`
The vertical counterpart to the dividend projection, and it exists for the same reason: selling moves
the marker, and a sandbox that moved cash and shares while leaving the chart frozen showed a market
no action could affect.

- `blocks` is how many 10% certificates went to the pool, because **the drop is per block, not per
  transaction** — selling 30% in one message is three rows, not one.
- **Takes a cell and returns one.** "The cell at $76" is ambiguous, and walking down from the wrong
  one lands where the marker never stood. The caller tracks the cell for exactly this reason (see
  `SandboxMarketMark`).
- **`y - 1` is down.** This chart's y axis is inverted relative to the screen. Written as `y + 1` the
  walk went *up* and a sale RAISED the price — and silently did nothing for a token already on the
  top row, which is where the fixture's PRR sits. Caught by the harness, which asserted the token
  moves and found it did not.
- Walks with plain indices rather than a `find` closure per step: a callback capturing the loop's own
  cursor is the `no-loop-func` hazard, and the cell below is a coordinate lookup, not a search.
- **Same scope caveat, and it matters more here.** The real chart has ledges that catch a falling
  token and a bottom row it cannot fall out of. This reproduces the FLOOR correctly and the ledges
  not at all. `market.rs` is the authority.

## Zones as rules

### StockMarketRenderer.tsx (zone lookup) — `marketZoneForPrice` is exported because zones are rules
Three surfaces outside the chart depend on them: the certificate count (Yellow and Orange shares are
exempt from the limit), the Stock Round buy control (Brown allows several bank-pool shares at once),
and the ledger. Those consumers must read the **same table the chart colours itself from** — a second
copy of "which prices are Brown" drifts the moment either is edited, and the failure mode is a player
being told a rule the board contradicts.
A named `certificate-limit exempt` predicate wraps the three-way test rather than leaving an inline
comparison, because the same test is made in two files and `zone !== "Normal"` is easy to write as
`=== "Yellow"` by mistake.

### StockMarketRenderer.tsx #196 — The zones are a vocabulary, not this chart's decor
The dividend panel must render a price in its zone's colour and explain the rule that colour stands
for. The facts already exist here — gradients paint the cells, `ZONE_LEGEND_LABELS` names them,
`ZONE_DESCRIPTIONS` states their rules.
**What was not exportable was the colour**, because a cell needs a multi-stop CSS gradient and text
needs one flat legible ink. Reaching for `ZONE_GRADIENTS` off-chart produces a `background` string
assigned to a `color` property: silently ignored, text renders default grey, nobody can see why.
So a flat text counterpart is hand-paired with each gradient and lifted for contrast against a dark
panel. It returns `null` for a price off the chart or in an ordinary cell — deliberately not a
default grey, so a Normal-zone price keeps whatever the surrounding panel gives it instead of being
re-tinted into something that looks like a fourth zone.

## The par track

### StockMarketRenderer.tsx #10 — The Par/IPO tray  *[data source superseded by #24]*
A geometry request asked to relocate the par cells to the board's bottom rows; re-fetching the
sourced `MARKET` array confirmed they genuinely sit at `x = 6, y = 5..10` and that rows `y = 0..4`
contain no par cells at all. So the main grid's par cells stayed where the source puts them, and a
**separate supplementary panel** was added alongside — matching the physical game's own separate
par-track component.
**Superseded data source, recorded for the trail:** the tray originally derived its markers by
watching `marketGrid.positions` and caching `(company_id → par price)` at module scope.
`MarketGridResponse` has no field recording a corporation's *original* par once it starts moving, and
there is no `GetParHistory` query — so that cache had a documented first-load gap (a client opening
after a company left its par cell could never learn its par) and, more importantly, **could not
represent a parred-but-unfloated company at all.**

### StockMarketRenderer.tsx #24 — Par is set at presidency purchase, not at float
**Rules correction, and the reason the `parredCompanies` prop exists.** A company's par is fixed the
moment its President's Certificate is bought — **not** when it floats. Floating is a later, separate
event (60% sold), and a company can sit parred-but-unfloated for a long stretch of a Stock Round.

The observed-position cache is gone. Markers come straight from `PublicCompanyState.par_value`, which
the contract sets at presidency purchase, and are **derived on every render** rather than accumulated.
More than one corporation can par at the same standard price, so each bucket is a list. The prop is
optional so callers with no game state (the placeholder path) render an empty track rather than
needing a stub.

### StockMarketRenderer.tsx #387 — No par, no token. Enforced at the renderer.
**Reported:** in the Zero State sandbox, unparred corporations show market values and render tokens.

A market position is a claim that a corporation **has a price**, and a corporation acquires one by
being parred. A token for a company with no par is not a stale figure — it is a corporation that has
not entered the market being drawn as though it had.

**The filter is at the renderer, not only in the fixture that produced the bad data.** The fixture is
fixed too (`sandboxInitialMarketPrices`), but fixing only the fixture leaves the invariant undefended
for live chain data, and the invariant is not a sandbox property: it is what a market position
*means*. A renderer that draws whatever it is handed will draw this again the next time any producer
gets it wrong.
`parredCompanies` is the authority because it is the same `PublicCompanyState.par_value` the par-track
markers trust — one source, so the token and the gold par marker cannot disagree.
**Unknown roster passes everything through.** The prop is optional (the placeholder path has no game
state), and treating "no roster supplied" as "nothing is parred" would blank the demo grid. Absent
evidence is not evidence of absence — the same rule `#385` applies to the private roster.

## Tokens on the chart

### StockMarketRenderer.tsx #5 — Token stacking, via an independent grid item
When several `MarketPositionEntry` share a coordinate their badges are staggered rather than
overlapping in place. **Token wrappers are separate CSS grid children**, explicitly placed at the same
`gridColumn`/`gridRow` as their coordinate — independent of whether a background price cell exists
underneath, so a token is never silently dropped even for a coordinate the real-shape mask does not
cover.
Company positions are grouped by cell into a **plain typed array** (not `Array.from(map.entries())`)
so the render below does not depend on `Map` iterator generics being fully resolved by whatever `lib`
a bare `tsc` run happens to see.

### StockMarketRenderer.tsx #8 — Defensive token placement
Every occupant is placed via a coordinate **clamped into the backend's own declared range**,
independent of whether that cell falls inside the authentic-shape mask. A token's actual on-chain
position is always rendered somewhere on the grid, even in the (believed impossible, but not provable
here) case that `market.rs`'s movement rules produced a position outside the real cliffside shape —
matching `HexGridRenderer`'s "unknown tile_id renders a visible placeholder rather than silently
nothing" honesty convention instead of dropping a real corporation's token.

### StockMarketRenderer.tsx #23(3) / #24(2) — Station-token circles, sized and clustered
**Direct feedback:** "the corporation trackers are too small to be read correctly… these are the same
circular markers used as station tokens… move the IPO/Par Track and the Legend to a row beneath the
matrix, and expand the matrix fully across the panel."

- The badge became a **fixed-diameter circle** (`borderRadius: 50%`, flex-centred ticker) sized off
  the live `cellSize`, matching the physical game's circular station-token pieces.
- `boardArea` changed from a **row** (grid + fixed-width side column) to a **column**: the price grid
  renders first at the panel's full width, and the tray + legend move into a row beneath it. Those two
  cards then use a **width** flex basis (`1 1 340px`) rather than the old column's height basis.
- **#24(2) recalibration ("too large"):** base ratio `cellSize * 0.85 → 0.62`, max diameter 64 → 46,
  min 20 → 16. A token now reads as a marker ON the cell rather than dominating it.
- **Multi-occupant shrink is a formula, not a table:** `tokenCountScale = 1.15 / sqrt(count)` floored
  at `0.45x` (1 → 1.0, 2 → ~0.81, 3 → ~0.66, 4 → ~0.58), so it degrades gracefully for **any** real
  occupant count rather than a hardcoded few cases.
- **Positioning is a ring, not a cascade.** The old linear diagonal cascade kept only the front-most
  token fully visible past three occupants (the PRR/NYC/ERIE case). A single occupant renders
  dead-centre; two or more spread evenly around a circle (`index / count` of a full turn, radius
  scaled to live cell/token size), so every token keeps a readable position. `zIndex: 10 + index`
  survives as the tie-breaker for residual overlap.

### StockMarketRenderer.tsx #430 — Where a herald stops being legible
26px is the diameter at or above which a token carries its historical herald instead of its acronym,
**chosen against the marks themselves rather than as a round number**: the PRR keystone and the B&M
shield survive scaling into a ~15px inner box (diameter less border, times the 0.56 fit factor)
because both are single bold silhouettes; below that the NYC oval and the CPR beaver become
indistinguishable smudges. The map's station tokens sit at 18px and stay on text for this exact
reason — this constant is that judgement as a number, because unlike the map these tokens resize.
**The ink is computed, not white.** The badge hardcoded `#ffffff`, fine on five of eight liveries and
unreadable on C&O cyan, ERIE yellow and NNH orange. It matters now because this colour is what the
**text fallback** is drawn in, and a fallback nobody can read is not a fallback. Same helper the
livery stripe and the map tokens use.

### StockMarketRenderer.tsx #452 — A crowded cell has to be readable
**Reported:** corporate tokens completely obscure the cell values — and it is worst exactly where it
matters most. `#24`'s ring is centred on the cell, so the more corporations share a price, the more
completely the price underneath disappears. A cell with four tokens is the one a player most wants to
read and the only one they cannot.

**Hover scatters and shrinks** — two effects, because either alone is insufficient at four occupants:
shrinking alone keeps them overlapping the centre, scattering alone pushes them into the neighbours'
tokens.
**CSS, not React state.** A hover that re-renders eight-plus grid items per pointer move is a lot of
work for a visual effect; `:hover` does it free with no state to get stuck, and degrades correctly on
touch (no hover, tokens stay put, the tooltip carries the price).
**The transform is a translation along the token's own spoke**, set as a CSS custom property from the
same offset that positioned it — so a token moves further out along the line it is already on rather
than toward a fixed point two tokens might share. A lone occupant has a zero offset and therefore does
not move, which is correct: it only needs the scale-down.

### StockMarketRenderer.tsx #648 — The cell is the hover target, not the token
**Reported:** "the scatter effect only works when the mouse is over a corporation token, but the
tokens are moving, so the effect happens and then undoes itself almost immediately."

A feedback loop, and `#452` wrote down the cause without seeing it: `pointer-events: none` on the
wrapper so "the hover is driven by the tokens themselves". **The tokens are what the hover moves.**
Pointer enters a token → token scatters out from under it → `:hover` lost → token returns under the
pointer → oscillation. The effect is its own off switch.

`pointer-events: auto` makes the **wrapper** the target, and the wrapper is a grid item filling the
cell, so the cursor stays inside it however far the tokens travel. The only stable version, because
the hover region no longer moves.
**The cost is the cell's tooltip, paid back in the same change.** The wrapper covers the cell, so it
carries the cell's own title. Tooltip text is therefore assembled by a shared `cellTitleFor` rather
than inline in the cell — otherwise moving the hover target silently drops the tooltip on every
occupied cell, which are exactly the cells whose price is hidden.

## Colour and fill priority

### StockMarketRenderer.tsx #7 — Cell boundary lines
Price-cell borders use `#3a4152` against the cell background so adjacent cells' shared edges read as a
continuous grid of boundary lines — the "token movement path" between neighbouring price steps —
rather than a loosely-spaced field of soft-edged boxes. Zone tints and par tints override the
**background** per cell, never the border.

### StockMarketRenderer.tsx #11 / #17 — Gradients are clipped to their own cell
Par and zone cells fill with a subtle diagonal lighter-to-darker gradient, one hand-paired shade pair
per palette entry (matching this file's explicit-palette convention rather than a runtime
lighten/darken helper). `styles.cell`'s `overflow` is `hidden`, **not** `visible`, so a gradient is
always clipped to its own cell box and never bleeds across the grid's `gap` into a neighbour.
Safe **specifically because live tokens are not nested inside a `.cell`** (`#5`: `tokenWrapper` is an
independent sibling grid item), so a deep token stack still spills visibly over neighbouring cells;
only each cell's own background is clipped.

### StockMarketRenderer.tsx #15 — The column-6 hard-block, and the accuracy correction it surfaced  *[superseded by #20]*
An inline `cell.x !== PAR_LADDER_COLUMN_X` guard stopped the par ladder's column picking up a zone
gradient. **Verified against `REAL_MARKET_ROWS` while formalising it:** the sourced Yellow/Orange/Brown
cells are *not* confined to `x = 0..5`. The bottom-left cliff rows each end exactly at `x = 6` with a
genuine tag — **`(6, 2)` = Yellow $60, `(6, 1)` = Yellow $50, `(6, 0)` = Orange $40** — all real
sourced values, and none of them among the six `PAR_VALUE_LADDER` cells (`y = 5..10`). The prior
guard silently suppressed colour on those three real cells as an unverified side effect.
Kept verbatim as the record of how the column-6 mistagging was found. **Superseded by `#20`:** the
whole column-index hard-block is removed, because a strict per-cell `zoneType` read is the correct
rule — including for these three cells.

### StockMarketRenderer.tsx #18 — Final visual theme pass
1. **`NORMAL_CELL_BACKGROUND` is an explicit branch**, not a fall-through to `styles.cell`'s implicit
   default. Same visible colour, now an intentional overwrite.
2. The `$350` game-end cell gained a vibrant green fill, dark high-contrast text and a dark-green
   outline (replacing a red ring that would fight the green).
3. **Zone gradients untouched** — verified by re-reading the priority chain: the game-end/par branches
   all come *before* the zone branch, so no sourced Yellow/Orange/Brown cell's colour changed.
4. The six par cells gained a `parGroupFrame` overlay — one grid item spanning their full outer
   bounding box, thick gold border, no fill, positioned via grid-line placement so its box includes
   the internal gaps and reads as one continuous frame rather than six per-cell borders.
5. The rule-zone legend's fonts, swatch size and gaps were upscaled to match `App.tsx #12`'s dashboard
   upscaling.

### StockMarketRenderer.tsx #19 — Legend relocation and grid-scale maximization
The horizontal legend row under the header is removed outright; the same content
(`ZONE_DESCRIPTIONS`/`ZONE_LEGEND_LABELS`/`ZONE_COLORS`, unchanged) renders through
`MarketRulesLegend` as a vertical swatch-over-label-over-description card, as an `aside` below the
tray in a shared `sideColumn`.
**Flex basis flips meaning with the axis:** the tray's old `flex: 0 0 340px` was a WIDTH basis as a
direct row child; moved into a column container it becomes `0 0 auto` (natural height) with the legend
at `1 1 auto` (fills the remainder), and the 340px basis moves up to `sideColumn` itself.
With that row reclaimed the `ResizeObserver` reports more height automatically. The ceiling is also
raised explicitly: `MAX_CELL_SIZE_PX` 72 → 120 and the price-font ratio 0.35 → 0.4, so a widescreen
pane grows past the old cap. Minimums untouched, so small panes degrade to the same legible floor.
The **gold frame's border and glow were literal fixed pixels** (4px/10px) that would look
proportionally thinner as the matrix grew, so both now scale off the live `cellSize` using the same
baseline-ratio pattern as the token offset.

### StockMarketRenderer.tsx #20 — Cell-specific tagged fills: read the tag, never the column
The priority chain used to branch on **two different things**: `isParValueLadder` / `cell.x === 6`
(coordinate checks) for the par column, and `cell.zoneType` for everything else — exactly the "sweep a
column, don't read the per-cell tag" pattern this pass was asked to eliminate.

`REAL_MARKET_ROWS` already tags all six par cells `"Normal"`, so a strict per-cell read puts them in
the same charcoal branch as every other Normal cell with no special case. The column-6 hard-block goes
for the same reason — the three real Yellow/Orange cells at `(6, 0)`, `(6, 1)`, `(6, 2)` render their
own gradient again.

**The chain is now three branches:** `isGameEndCell` (green) → `zoneType !== "Normal"` (that zone's
gradient) → `NORMAL_CELL_BACKGROUND` (charcoal). Text colour mirrors it exactly, so brightness can
never disagree with whether a background tint actually rendered.
`NORMAL_CELL_BACKGROUND` and the price ink are **promoted to the former neutral-fill values**
(`#343a45` / `#c8ccd6`) rather than the dimmer originals, satisfying "high-contrast" for every Normal
cell uniformly. The gold frame needed no change: it was always an independent grid item positioned by
the ladder coordinates, never coupled to the cells' fill.

### StockMarketRenderer.tsx #402 — The gold frame sits in the grid, not on it
**Reported:** the gold rectangle looks "pasted on" — reduce its stroke ~40% and blend it in.
At 4px against a ~40px cell the frame was a tenth of a cell wide, heavier than any line the chart
draws for itself (2px gaps, 1px cell borders). A rectangle at four times the weight of everything it
encloses cannot read as part of the same diagram, and the wide opaque glow compounded it by casting
gold onto neighbouring backgrounds.
`4 → 2.4px` is the requested cut, **kept fractional rather than rounded to 2** so the ratio survives
scaling at large cell sizes — hard-rounding the baseline would make the reduction disappear at the top
of the range. **The floor drops with it, 3 → 2**: a floor of 3 against a 2.4 baseline silently cancels
the change at ordinary sizes, which is the kind of fix that ships and does nothing.
**The glow halves and goes translucent rather than being deleted** — it is what stops the thinner line
vanishing against the dark chart. At 45%/10px it was a gold wash; at 22%/5px it reads as the line's
own edge.

### StockMarketRenderer.tsx #23(1) — Positioned elements paint after non-positioned ones
**Reported:** the gold frame was not rendering as one continuous rectangle — each par cell looked like
it had its own segment.
Root cause: the frame was rendered **later in the JSX** than the price cells, so it looked like it
should paint on top — but every cell sets `position: relative` while the frame had no `position` at
all. **Per CSS 2.1 painting order, positioned elements always paint after non-positioned ones within
the same stacking context, regardless of DOM order.** Each cell's steel-gray border painted over the
gold at every internal boundary, leaving only the true outer perimeter continuous.
Fixed with three **explicit, ordered layers** rather than relying on DOM-order/position-type interplay
that happened to work for tokens but not the frame: cell `zIndex: 1`, frame `position: relative` +
`zIndex: 6`, token wrapper `zIndex: 10`.

### StockMarketRenderer.tsx #24(1) — Par-cell number clipping  *[undone by #649]*
The frame's `border-box` stroke was drawn flush against the same edges the six par cells' left-aligned
price text starts from (2–3px padding). At the raised `MAX_CELL_SIZE_PX` of 120 the scaled border
passes 10px — wide enough to overlap the leftmost stroke of "90"/"82"/"76"/"71"/"67"/"100" now that
the frame paints above them. Fixed by **centring** those six cells' text, set per-cell at the render
call site rather than in the shared `styles.cell` (which stays left-aligned). The absolutely
positioned "PAR" badge is unaffected — `justifyContent`/`alignItems` act only on normal-flow children.

### StockMarketRenderer.tsx #650 — The par cells are tinted, not framed
**Reported:** "rather than the gold rectangle around those six cells, which still looks odd or tacked
onto the board, maybe we should tint the cells green?"

The frame was fought with for four passes — `#18` added it, `#19` scaled it, `#20` stopped it drawing
as six segments, `#23(1)` fixed its stacking layer, `#402` thinned it, `#24(1)` centred the prices to
dodge it. Every one was a real fix and the object stayed foreign, **because an overlay drawn on top of
six cells is a different KIND of thing from everything else on this chart: every other meaning here is
a fill, and this one alone was a box.**

A tint makes it the same kind of thing, and the whole class of layering, seam and clearance problems
stops existing. **Green, distinct from the game-end green** — same hue family (both are good news for
a shareholder), clearly different weight (one is a starting option, the other ends the game): that
cell is a vivid gradient, this is a flat muted tint.
**Priority below the zones.** A par cell that is also a zone cell would be a rules conflict rather than
a display one, and on this board none is. Ordering the tint after the zone test means that if the
board ever changes, **the zone wins and the tint yields — a zone carries a rule, the tint carries an
option.**

### StockMarketRenderer.tsx #649 — Every price in the same corner
**Reported:** "the cell values are in the upper left, other than the 6 cells in the par column where
they are centered (I would prefer they occupy the same top left position)."
`#24(1)` centred them to dodge the frame. **The frame is gone (`#650`), so the dodge has nothing left
to dodge** — and it was never free: a column of prices all sitting in one corner is scannable down the
grid, and six that jump to the middle break that line for no gain.

### StockMarketRenderer.tsx #651 — The colours have to say what they mean
**Instructed:** "since we've decided not to tuck crucial/otherwise undiscoverable game information in
tooltips, we probably need to re-add the cell color legend to the bottom of the stock market matrix
panel, including the green tint from 4b to explain that those are par values."

The legend existed, moved to a side column (`#19`), then off the matrix entirely — and every removal
left the colours meaning something they only stated on hover. `#43` already worked through the same
problem for the cliff arrows: **the board's edges are RULES, and a tooltip is not where a rule lives.**

**Under the matrix, not beside it.** A side column competes with the grid for the width the grid is
trying to maximise (`#19` and `#21` both fought this), and a legend is reference — read once, early,
then rarely. Below is where it costs the thing it explains nothing. A wrapping row rather than a fixed
grid: six entries at a comfortable width, folding to two lines on a narrow window with no breakpoint
to maintain.
**It reads its own swatches from the fills the grid uses**, so a swatch cannot come to disagree with
the cell it describes. **That guarantee is one-directional**, and `#652` is the proof: sourcing the
colour from the grid does not check that any cell actually *uses* it. **Every legend row must name a
fill some cell paints.**
Removed with the overlay they scaled: `PAR_LADDER_COLUMN_X`, `PAR_LADDER_ROW_MIN`/`_MAX`, the frame
border/glow baselines and their derive helpers. All three coordinates existed to place one thing and
to keep a guard from drifting from it; with the overlay gone the six cells are found the way every
other special cell is — **by the flag the cell itself carries** (`cell.isParValueLadder`). That is the
anti-drift argument those constants were written to make, finally made by the data.

### StockMarketRenderer.tsx #9 / #27 / #652 — $350 is a ceiling, not an ending
`#9` marked the top-right cell (`x = 18, y = 10`) as the coordinate `market::GAME_END_PRICE_TRIGGER`
watches, with a red outline and a "GAME END" tooltip — **purely a player-facing hint**, since the
gameplay logic lives on-chain.

**Instructed (`#652`):** "make sure the 350 price is not a game end condition anymore. We were
supposed to have removed that, both from rules reference and the grid, as well as the actual game end
mechanics." It was removed from the rules text (`#27`) and only **half** removed from the grid:
`isGameEndCell` was switched off with a literal `false &&`, on the reasoning that re-enabling it would
be a one-line change.

**A flag that is provably always false is not a switch — it is a claim the code keeps making and the
board keeps not honouring**, and it carried a whole apparatus: the coordinates, a green gradient, a
dark-on-green text colour, an outline, an `END` badge and a tooltip line. **It had already misled one
reader**: `#651`'s legend sourced its swatches from the constants the grid paints with and duly gave
"Game end" its own row — a legend entry for a rule no cell has. The dormant flag survived because
everything around it still looked live.

**What actually ends the game in this frontend** is `GameEndReason` in `GameOverModal.tsx` —
`"bankruptcy" | "bank-broken"` — and it never had a price path.
**Out of scope, still live:** the contract *does* fire on price. `market.rs` defines
`GAME_END_PRICE_TRIGGER: u128 = 350` and `price_triggers_game_end`, checked in `trading.rs` and
referenced from `escrow.rs`. `#27` flagged this as backend-audit debt and it is **still owed**; until
it is removed, a live-chain game and a sandbox game disagree about whether $350 ends anything.
The tooltip assembler is exported alongside `PRICE_GRID` because the tooltip is where the removed
"GAME END" sentence lived — it is the string a regression test has to inspect.

## Sizing and layout

### StockMarketRenderer.tsx #12 / #13 — Measured cell size, derived font size
`CELL_SIZE_PX` is no longer used for layout — it is the pre-measurement fallback and ratio baseline. A
`ResizeObserver` on the grid wrapper measures the space actually available (deliberately excluding the
tray sibling, which keeps its natural width) and derives the largest cell size that fits all columns,
clamped to `[MIN, MAX]`. Everything proportional scales off it via the same baseline-ratio pattern:
token stagger, price font, frame border, token diameter.
**#13:** because this is DOM/CSS-grid rather than canvas (`#2`), "scale the font relative to cell
dimensions" becomes a computed CSS `fontSize`, not a `ctx.font` assignment — same intent, different
API. Floored at a minimum so the smallest clamped cell stays readable; base weight bumped 400 → 600 so
numbers read bold at every size, not just large.

### StockMarketRenderer.tsx #21 — Page-level scrolling, and why this needs no height math
Mirrors `HexGridRenderer.tsx #27` for DOM/CSS-grid rendering. `styles.root` drops `overflow: auto`
(this panel's own inner scrollbar — the "cramped inner frame window") and `height: 100%` (a percentage
that only ever resolved against `App.tsx`'s `boardPane`, which no longer imposes a definite height on
purpose — see `App.tsx #13`); the grid wrapper drops its `overflow`/`minHeight`.
**Unlike the canvas sibling, this needs no derived-height math at all.** A CSS grid's height is
intrinsic to its content (rows × `cellSize` + gaps), so removing the `cellFromHeight` term — leaving
`cellSize` derived from available **width alone** — is the only change needed. The grid's natural
height cascades up the unclamped flex chain to the page, where the browser's own scrollbar takes over.
`REAL_BOARD_ROWS` is consequently no longer needed for sizing.

### StockMarketRenderer.tsx #25 / #26 — The matrix dominates
`#25`: matrix + par track on one row, wrapping on a narrow window so the track drops below rather than
squeezing the grid. `ZONE_COLORS` is removed — it existed only to paint the deleted legend's swatches;
the cells use gradients, and every non-Normal cell carries its label + description as its `title`.
`#26`: `boardArea` already carries `flex: 1`, but the tray's `flex: 0 0 340px` claimed a fixed third of
a 1000px pane, so the chart — the entire point of the tab — got two thirds at best. The tray is pinned
to `0 0 168px` (a price and a row of ticker chips) and the matrix takes everything else.
**`minWidth: 0` on the matrix is what actually makes it work**: without it a flex child refuses to go
below its content width and the tray gets squeezed instead. The tray still wraps to its own row on a
genuinely narrow window, which is the right failure mode — a 168px tray beside a crushed matrix helps
nobody.

### StockMarketRenderer.tsx #14 (palette decoupling) / #16 / #22 — Tray palette, tooltips, terminology
- **#14:** the tray had used the same warm gold palette as the main grid's par cells, visually adjacent
  to and easy to confuse with the chart's warm Yellow/Orange/Brown zone tints. It now has its own
  neutral steel-gray palette, independent of both, keeping only a small coloured price-text accent so
  the six prices stay distinguishable. Zone-tinted cells render their price in bright bold ink against
  the soft gradient, instead of the dim gray used for Normal cells.
- **#16:** tooltips carry **no raw coordinates**. `(x, y)` is meaningful to a developer cross-checking
  the source array and meaningless to a player. The zone portion leads with the zone's proper name, not
  its bare rule sentence: `"Yellow Zone: Certificates here do not count toward certificate limits."`
- **#22:** terminology audit — every tooltip-facing "hand limit(s)" becomes the official 1830 term
  **"certificate limit"**. Standard cells (which includes the six par cells, since the source tags them
  `"Normal"`) previously said nothing about the limit; they now append an explicit "Stocks count toward
  certificate limit.", the accurate counterpart to the zones' explicit *exemption* wording, so hovering
  any cell states its status one way or the other. The frame's gold was also recoloured to `#EAB308`.
- **#23(2) tooltip trim.** Direct feedback: "the tooltip for these values just needs to say 'Par Value'
  and the rule for the cell, the extra stuff is unnecessary." Four clauses became two — `Par Value $X`
  and the certificate-limit rule. "valid starting price" and "Starting IPO / Par Value Selection." were
  both redundant restatements of the fact the leading label already establishes.

### StockMarketRenderer.tsx #6 / #428 — One livery table, three former mirrors
`#6` assigned ticker colours per `company_id` from a fixed local palette, not derived from anything the
backend sends — purely a legibility aid so a corporation reads as the same colour everywhere, with a
neutral gray fallback outside the palette's range rather than a throw.
**`#428` deleted the local copy.** It was a hand-kept mirror of the same eight colours
`hexContractTypes.ts` and `StockRoundPanel.tsx` also held — three copies that `#408` could only keep in
step by instructing future readers to update all of them together. The table now lives in
`styles/corporationLivery.ts` with a single reader, so a recolour physically cannot reach one surface
and miss another.

---

# The Stock Round Panel — `StockRoundPanel.tsx`

The Stock Round action surface: a card per corporation carrying its market/par prices, ownership
table, operating snapshot and its own buy/sell controls. Renders above the market matrix whenever a
Stock Round is live. Buy/Sell/Pass ownership moved here entirely — `ContextualActionBar`'s Stock-Round
button branch is emptied in the same pass so there are never two competing sets of controls.

## Charter

### StockRoundPanel.tsx #1 / #2 — Presentational, over an unchanged backend surface
Same "`App.tsx` owns state, child components render it" split used throughout (`TopTicker.tsx #1`,
`InlineQuickChat.tsx #2`): every piece of selection state is owned above and threaded down, with plain
callback props for every mutation.
**No new backend surface.** `BuyStock`/`SellStock` already accept every parameter these controls
produce (`source: "Ipo" | "Bank"`, `par_value: string | null`, `percentage: number`) — this is a pure
frontend selection layer feeding the existing `runGameplayAction` plumbing untouched.

### StockRoundPanel.tsx #8 — The corporation roster, and why the president is the point
A card per corporation: market price, IPO/par price, and who owns what. The panel previously showed
only the *selected* company's numbers, so the one question a Stock Round is actually about — who
controls what, and what would it cost me to take it — could not be answered without clicking through
all eight and holding the results in your head.

**Presidency is the only thing in 1830 that confers control**, it changes hands silently the moment
someone outbuys the incumbent, and missing that it has moved is how players lose games. So it is marked
**two ways at once, deliberately redundantly**: a bold gold row and the word "President" spelled out.
Colour alone fails a colourblind player; the word alone is easy to skim past in a dense table, which is
why it is a tag rather than running text.
A crown glyph was the third channel and `#490` removed it with the rest of the card's emoji — it was
the weakest of the three, because **an emoji renders in the platform's own colour font at its own
weight, ignoring `color` and `fontWeight`**, so it could not be tuned to sit with the typography around
it. A channel that cannot be styled to match its table is decoration wearing an accessibility argument.

**What this never does: derive the president.** `president` is a contract field, and the largest holder
is **not** reliably the president — 1830 presidency only transfers when someone *strictly exceeds* the
incumbent, so a tie leaves it where it was. Computing it from `player_holdings` would look right almost
always and be wrong at exactly the moments that matter.

### StockRoundPanel.tsx #13 (market price prop) — A separate prop, because it is separate data
Live price per `company_id` is a prop rather than a field on `PublicCompanyState`, because on a real
chain it genuinely is separate: `GetGameState` carries the par value and the ownership registry,
`GetMarketGrid` carries the live market position. Folding one into the other would invent a shape the
contract never returns.
**A missing or `null` entry means "no market position"** — the correct state for an unfloated
corporation — rendered as a dash, never as `0`, since a zero share price means something very different
from not having one.

## The card as the control surface

### StockRoundPanel.tsx #10 — Actions live in the card
The global action panel is gone. It was five sections — company pill-selector, float bar, par grid, buy
control, sell control — all silently keyed to whichever pill was selected. So eight cards showed the
position and a separate stack of controls below acted on one of them, connected only by a highlighted
pill. Reading "PRR: Alice 60%" and then operating a Buy button eight inches away that may or may not be
pointed at PRR is exactly the ambiguity the auction had, with twice as many companies.
**Expansion is the selection.** Expanding a card reveals its own float bar, par ladder, buy and sell
controls; the pill row is removed.

**Accordion here, flat in the auction — the asymmetry is deliberate.** An auction card has ONE legal
action and six cards to compare, so hiding a single button behind a click is pure cost
(`WaterfallAuctionDashboard.tsx #17`). A corporation card has a par ladder, a source toggle, five sell
sizes and two buttons — roughly twenty controls — and there are eight of them. **The rule is about
content volume, not house style.**

### StockRoundPanel.tsx #26 — The card paradigm test  *[superseded by #388]*
This file carried a long comparison of two paradigms behind a `USE_FLIP_UI` flag — Option A, an
accordion that reflows the grid; Option C, a 3D flip with a fixed 460px frame — on the reasoning that
which is better is a judgement about how the screen is used and should be settled by trying both.
It was settled. See `#388`. The flag is deleted rather than left switchable, because **a flag nobody
will flip back is just a second code path to keep working.**

### StockRoundPanel.tsx #388 — The flip is gone
**Reported:** remove the 3D card flip entirely and render every action on the front.

`#26` chose the flip to solve a real problem — the grid reflowed when a card expanded, so choosing
between eight corporations meant the other seven jumped under the pointer, and a rotated card occupies
exactly the space it did before.

**It cost more than it saved, and `#27`'s history is the evidence.** Hiding the numbers behind the
decision meant re-deriving a condensed holdings list, a second price readout and a second pool row for
the back face — a whole parallel rendering that then had to be kept in agreement with the front (`#355`:
"same suppression on the card back, so the two faces agree"). Then the flip needed a `stopPropagation`
guard so operating a control did not spin the card away mid-decision, and that guard needed revising
when it turned out to swallow clicks on padding.
Putting the actions on the front deletes the parallel render, the guard, and the fixed 460px frame that
imposed the tallest card's height on all eight — and the controls now sit directly beneath the ownership
table they are a decision about. The reflow `#26` worried about is handled by the card keeping its own
height: actions render for the **expanded** card only, exactly as the accordion always did.

### StockRoundPanel.tsx #29 — The target company travels with the click
Every card renders its own Buy/Sell, so there is no shared selection for them to read;
`selectedProtocolId`/`onSelectProtocolId` are gone from the interface for the same reason. (Companion
to `App.tsx #29`.)

### StockRoundPanel.tsx #348 — A flipped card belongs to whoever flipped it
**Reported:** after a player buys and the turn passes, the previous player's flipped tile is still
flipped for the next player.
`expandedCompanyId` is session state — it survives every re-render, including the one where the turn
moves — and nothing cleared it. In hotseat that is the whole bug: Bob picks up the mouse and finds
Alice's PRR card open on its back, showing her holdings and her controls.

**Why a turn change and not a purchase.** The tempting hook is `onBuyShare`, but a player can flip a
card, read it and pass without buying — and the card would still be open. **The turn moving is the
actual boundary**: the moment the surface stops belonging to one person and starts belonging to another,
whatever they did with it.
Keyed on the **label** rather than an address, because that is what this component is given and it is
already resolved per seat. Passing to a seat with the same name would not re-fire — which cannot happen,
since the label derives from the seat and the seats are distinct.

### StockRoundPanel.tsx #34 — Hotseat, and who is up
**Reported:** the Stock Round is non-interactive in Sandbox, and it is unclear whose turn it is.
The header said "Waiting for your turn…" whenever `isMyTurn` was false and named nobody — so on a shared
keyboard it was a prompt to wait for yourself, and with every seat truncating to the same address
(`WaterfallAuctionDashboard.tsx #31`) there was no way to tell who it was waiting for.
`hotseat` swaps that message for the seat's **name** and suppresses the "waiting" framing entirely:
**at a shared keyboard nobody is waiting, somebody just needs to pick up the mouse.**

## Buying

### StockRoundPanel.tsx #18 — Buy source is local
`source` was a single value owned by `App.tsx` and threaded into every card, so flipping IPO/Bank on one
card flipped it on all eight. Invisible while only one card was expanded, obvious the moment they all
were — and a real hazard either way, because **the toggle a player set on PRR silently governed the
purchase they then made from B&M.**
The previous pass removed the shared *company* selection for exactly this class of bug and left the
shared toggle behind, which is the more interesting mistake: "which company" and "which source" are the
same kind of per-card decision, and fixing one without the other left half a bug in place.

### StockRoundPanel.tsx #35 — The buy button always prices itself
The label showed a price only while the company was **unfloated**, so the moment a second source
appeared the suffix vanished and the button read a bare "Buy 1 share" — exactly when a price mattered
most, because the player now had two to choose between. The two sources genuinely cost different
amounts, which is the whole reason the toggle exists:

| source | price |
|---|---|
| IPO | the corporation's **par** price |
| Bank Pool | the current **market** price |

**Par comes from the company once it is set.** `parValue` is the ladder *selection* — a control, not a
fact — and is only what the buyer pays on the very first purchase, the one that sets par. After that
`company.par_value` is the price, and reading the ladder would quote whatever the player last clicked.

### StockRoundPanel.tsx #35 / #36 / #587 — The first purchase is a President's Certificate
**The first purchase is not a 10% share, and pricing it as one understates the cost by half.** Whoever
buys into a corporation with no president takes the President's Certificate: **20% of the company, at
double par.** Quoting "@ $67" for a $134 transaction is the kind of wrong number a player only discovers
after signing. Keyed on `president === null` rather than on a percentage, because presidency is a
contract field and the shares-sold arithmetic is a derivation.

**#36 — the gate is BOTH conditions, not either.** The President's Certificate is the first thing sold
out of an IPO, so "somebody holds shares" and "there is no president" cannot both be true in a legal
1830 position — and the sandbox's C&O fixture proved how easily an illegal one slips in
(`sandboxState.ts #6`: two players at 10% with no president). Reading `president === null` alone made
the card offer a President's Share two people had already bought around. Requiring both means a
malformed state degrades to the **conservative** answer — an ordinary 10% share — instead of advertising
a certificate that cannot exist.

**#587 — the test is "has this corporation been STARTED", not "does anybody hold a share".** The Camden
& Amboy hands out a certificate before anyone founds the company, so holders-without-a-president is an
ordinary opening position — and the old test refused the founding purchase to exactly the player holding
that certificate. **`par_value` is the field that says whether the company has been started.**

### StockRoundPanel.tsx #357 — A player cannot spend what they do not have
**Reported:** players can spend into negative cash — $74 buying an $82 share.
The button gated on turn and session readiness and **never on price**. The sandbox reducer's
`adjustCash` floors at zero rather than refusing, so the purchase completed, the share arrived, and the
buyer's balance read $0 instead of −$8. Quiet, and the kind of wrong that only shows up when somebody
reconciles the bank.

**The gate is the TOTAL cost, not the unit price**, and the two differ in both directions that matter: a
President's Certificate is double par, and a Brown-zone multibuy is `n` times the price. Gating on the
unit would let a player buy a $134 presidency with $70.
**`null` cash leaves the gate OFF.** A room that does not report a balance is not a room where the
player is broke, and blocking every purchase on missing data would be worse than the bug.

## The par ladder

### StockRoundPanel.tsx #3 — The par grid only matters pre-float
Once the selected company's `is_floated` is true, `App.tsx` passes `par_value: null` regardless of grid
selection — a floated company's share price comes from the market chart, not a fresh par choice. The
grid stays visible for context but is visually marked inactive so it never reads as "still doing
something."

### StockRoundPanel.tsx #399 / #415 — The ladder is derived from the board's own par boxes
Exported since `#399`, because the B&O prompt offers the same six rungs and **two copies of a price
ladder is two ladders that can differ.**
`#415` moved the boundary one file further: it was still a hand-written `["67", "71", …]`, which meant
two ladders existed — this list of prices a player may **choose**, and
`StockMarketRenderer.PAR_VALUE_LADDER`'s list of prices the board has **boxes** for.

Those must be the same set, and **the failure when they are not is silent rather than loud**:
`placeParMark` resolves a par through `parBoxCellFor`, which returns `null` for any price not in the
ladder. A seventh rung added here and not there would let a player par a corporation at a price that
puts no token on the chart at all, and the company would read "not on the market chart" forever with
nothing to explain why. Deriving means the two cannot disagree. `String` conversion is the only thing
this file adds — the radio group takes strings, the coordinates table is numeric.

## Selling

### StockRoundPanel.tsx #20 — Sell size is local too, and this is what fixes the stuck highlight
`sellPercentage` was the last survivor of the shared-selection model. Two consequences, the second being
the reported bug:

- picking 30% on PRR silently changed the size on all eight cards; and
- on any card where the viewer holds nothing, **every** size is disabled, so the click never fires and
  the highlight never leaves its initial 10% — which looks like a broken toggle rather than "you have no
  shares here".

Local state fixes the first outright. The second is now honest instead: the row still disables sizes you
cannot cover, but the card you *can* sell from tracks your click independently.

### StockRoundPanel.tsx (sell options) — The full domain, with reasons attached
Sizes are 10% certificate blocks up to the **50% Bank Pool cap** (F-6). It was `[10, 20, 30, 40]`, which
silently made a legal move unreachable: a player holding 60% could not dump 50% in one action, and a
president executing a legal dump-and-transfer had no control for it. The backend accepts any multiple of
10 up to holdings, bounded by the pool cap; the UI simply did not offer the top step.
**The list is now the full domain and legality is decided per-entry.** Rendering illegal ones greyed
*with a reason* is deliberate: an absent control teaches a player nothing, while a disabled one saying
"would exceed the 50% Bank Pool cap" teaches them the rule at the moment it applies to them.

**Two independent limits, reported separately because they call for different actions:**

- **Holdings.** You cannot sell shares you do not have. Nothing to be done this turn.
- **Pool cap.** The pool has room for `50 − bank_pool_percentage` more. This one **moves** as other
  players buy out of the pool, so a player who knows the reason knows to wait rather than assuming the
  UI is broken.

Holdings is checked first: if you cannot cover the bundle at all, saying so is more useful than a
pool-cap message about shares you never had.

### StockRoundPanel.tsx #19 / #22 / #30 — The slashed sell row
Supersedes the five-chip stepper, which had its own bug worth recording: as a non-wrapping flex row the
50% chip overflowed the card border entirely at four columns — **flex does not shrink past content, so
nothing clipped it, it just rendered outside.** A single inline row of text-weight options cannot
overflow the same way because it wraps as text.
**#30 — no wrap.** Five options plus four separators is a fixed, known width; there is nothing to
reflow, and wrapping only ever dropped the trailing "50%" onto a line of its own, which read as a sixth
control rather than the fifth. Padding and gap are tightened to buy the width back rather than letting
the row break.

## Float, certificates, and locked rounds

### StockRoundPanel.tsx #4 / #24 / #445 — Float is the 60% rule, with no exceptions
The float indicator mirrors `public_company.rs`'s real condition: shares actually reaching player hands
is `100 − ipo_pool_percentage − bank_pool_percentage`. The 60% threshold marker is drawn on the same
bar, and **`is_floated` is the ground truth** — the bar can visually read past 60% before the backend has
processed the float on a given poll tick.

**There is no auto-float route, and no corporation floats during the Auction Round** — the auction sells
**privates**, and no share changes hands in it. Winning the B&O private grants the President's
Certificate and prompts a par choice. That is all it does; the B&O then floats on the ordinary 60% rule
in a subsequent Stock Round like every other company.

**#445:** this note used to say the badge was "ready for" an auto-floated state, and the badge named the
rule. Both removed. The distinction that matters: **`auction.rs` setting `is_floated` is a CONTRACT BUG
on the audit list, and a frontend that explains a bug in the language of a rule is how the bug becomes
the rule.** `is_floated` is still what the badge reads — it is contract state and the frontend does not
overrule it — but when it disagrees with the 60% math the card reports the **disagreement** and names no
cause. On a corrected contract that branch never fires.

### StockRoundPanel.tsx (certificate count) — A President's Share is one certificate, not two
**Not `percentage / 10`.** A President's Share is a 20% *double* certificate — one piece of card worth
two ordinary shares — so a president on 60% holds **five** certificates (one 20% + four 10%), not six.
This matters beyond pedantry: **the certificate LIMIT is per certificate, not per percent**, so a UI
counting a president's holding as six overstates their position against the limit by exactly one per
presidency. `isPresident` comes from the contract field, never derived from who holds the most (`#8`).

### StockRoundPanel.tsx #32 — Trading is a Stock Round action  *[superseded by #417]*
This existed because the roster became a **persistent tab** (`App.tsx #41`) and is now reachable during
the Operating Round and the auction. Leaving Buy/Sell live outside a Stock Round would let a player fire
a `BuyStock` the contract is certain to reject, and a rejected transaction is a worse explanation than a
disabled button.

### StockRoundPanel.tsx #417 — Outside a Stock Round there are no controls
**Reported:** remove the Buy/Sell buttons when the game is not in a Stock Round. Do not just warn — hide
them.

`#32` argued "a rejected transaction is a worse explanation than a disabled button". True, and it
answered the wrong question. **The choice is not between a disabled button and a rejected transaction;
it is between a disabled button and NO BUTTON** — and a disabled control claims something a hidden one
does not: that this is an action available here, blocked for a reason the player might fix. Nothing
about an Operating Round is fixable by waiting on this card.
The roster is a **reference** surface for most of the game, and a reference surface carrying eight
cards' worth of greyed Buy, Sell, source-switch and par controls is a screen mostly made of things that
do not work. The panel still states why **once**, at the top, via `actionsLockedReason` — one sentence
for the whole roster rather than forty dead controls saying it individually. The controls derive from
that same sentence rather than a second condition that could disagree with it.

**Guarded at the render, not at the call site, and the placement is load-bearing:** this component holds
`useState`/`useEffect`, so an early return above them would change hook order between rounds and crash
the card. **Every hook has run by that line; only the render is skipped.**

### StockRoundPanel.tsx #464 — Order recomputed at the Operating Round boundary
`null` until the first Operating Round establishes an order, which leaves the roster in the contract's
own table order — a neutral starting arrangement rather than one that reshuffles as the opening Stock
Round's first companies float.
**The effect fires on the TRANSITION into an Operating Round, not while one is in progress:**
`prevRoundRef` is what makes it an edge rather than a level, so a poll landing mid-round cannot re-sort
the cards under a player who is reading them.

## Card anatomy and layout

### StockRoundPanel.tsx #9 — Paper cards
Matching the auction's private-company treatment (`WaterfallAuctionDashboard.tsx #15`) and for the same
reason: **a dark card on a dark panel is a rectangle you have to hunt for**, and these eight are the
objects the Stock Round is about. Every child colour is re-derived for dark-on-light; the president row
in particular needed a real rework, since its gold-on-near-black was illegible the moment the card went
white.

### StockRoundPanel.tsx #11 — Responsive without a media query
`auto-fit` plus a 300px floor gives 1 column on a narrow window, 2 around tablet width, 3–4 on desktop
and 4 at the 1440px cap — the same ladder a `grid-cols-1 md:grid-cols-2 xl:grid-cols-4` chain expresses,
but **driven by the space actually available rather than by viewport width.** That distinction matters
here because these cards sit inside a padded pane, not against the viewport edge, so a viewport-keyed
breakpoint would switch a column too early. (Inline styles cannot host `@media` at all — see
`Lobby.tsx #3` on the same limitation for `:disabled`.)

### StockRoundPanel.tsx #23 — `start`, not `stretch`; and the whole card is the toggle
Stretching was right while every card was permanently expanded and roughly the same height. With the
accordion back, one open card stretched all seven collapsed ones to its full height, leaving each a
small block of content floating in a large empty rectangle — and **that empty space was inside the card,
so it looked clickable-but-dead** even though the whole card is in fact the hit target. Cards now hug
their content.
The header block **is** the accordion toggle: `width: 100%` plus the card's own padding means every
pixel of the collapsed body, including the gaps between rows, is inside the button and carries its
pointer cursor.

### StockRoundPanel.tsx #378 / #466 / #507 — The ownership table is a grid, and its width is one number
**#378 — a grid, not a flex row per line.** The old list used `justify-content: space-between`, which
pins the name left and the figure right and lets the gap vary with the name's length — so a column of
percentages did not line up, **which is the one thing a table of numbers exists to do.** Fixed tracks
put every figure on the same axis whatever the shareholder is called.

**#507 — one width, written twice, updated once.** *Reported:* a recent widening of the Shares column
pushed the Price column right, clipping it at the card's edge. The table encoded its numeric column
width in **two** places — the grid tracks (`46px 46px`) and the cell's `minWidth: 68px`. `#466` widened
the second, correctly, because "9 (100%)" is a real value (a full IPO) and it was wrapping — and left
the first at 46px. **A grid item cannot shrink below its own `min-width`, and a grid track does not clip
what overflows it**, so each numeric cell spilled 22px past its track; two of them puts the Price column
44px beyond where the grid put it.
**Nothing looked wrong at either site.** 46px is a reasonable track and 68px is a correct minimum; they
are only wrong *together*, which is why the widening pass had no reason to notice. There is now **one
number**: the track and the minimum read the same constant, making "the track is at least as wide as its
content requires" true by construction. Same fix TD-1 applied to the corporation palette and `#499` to
the route table's headers.
**The space comes from the entity column**, which is what the report asks for and where it should come
from: `minmax(0, 1fr)` is the only track that can give, it holds a name that already ellipsises, and on
every row but the longest it has slack.

### StockRoundPanel.tsx #421 — The highlight follows the reader
**Reported:** highlight the viewer's own row instead of the president's. Keep the crown on the president
but drop their highlight, and remove the "you" tag.
**The row highlight and the crown were saying the same thing twice**, which is what made the amber wrong
rather than merely misplaced. A crown is already an unmistakable permanent mark of the presidency, and a
filled amber row behind it added emphasis to a fact that needed none. Meanwhile the one row a reader
actually scans for — their own — was marked by a small pale "you" pill at the end of a name, the weakest
position in the row and the last thing the eye reaches.

So the two swap weights: the crown carries the presidency alone on a plain row; the fill carries **"this
one is yours"**, which is the question a player asks every time the table is on screen and the only one
whose answer differs per reader.
**The tag is deleted, not moved** — with the row highlighted, a pill spelling out the same thing is the
duplication this note just removed from the president, reintroduced one column left. `isSelf` survives as
the flag driving the fill. **Nothing is lost for a hotseat player:** `isSelf` needs a `connectedAddress`,
which a shared keyboard does not have, so no row highlights there — the same behaviour the tag had, since
it was gated on exactly the same value.
The style was **renamed rather than repointed**: `rosterHoldingRowPresident` described the thing it was
wrong about, and a later reader handed a style with that name would reasonably put it back on the crown.

### StockRoundPanel.tsx #31 / #489 / #504 — The operating snapshot strip
A **bordered strip** rather than three loose pairs, so it reads as one block of "how it operates",
distinct from the prices above and the holdings below. `flexWrap` because a corporation at its Phase 2
limit can hold four chips, which will not sit beside two more cells on a narrow card.
**#489 — treasury is flush right via `marginLeft: auto`, not `space-between`**, because the row's other
three cells must stay grouped at the left as a sequence: spacing them apart would make treasury look like
the fourth in a series instead of the balance it is. `alignItems: flex-end` right-aligns the value over
its caption so the figure ends flush with the card edge.
**#504 — a column, value over caption**, matching the price row's exact shape so both rows of the card
caption their values the same way round. It was an inline row with the label first, which made the asset
row read in the opposite order to the price row directly above it. `alignItems: flex-start` rather than
`center`: the chips are wider than their captions, and centring would float each word under the middle of
its chip row instead of aligning with the row's left edge, which is where the eye returns.

### StockRoundPanel.tsx #389 / #501 / #503 — Livery stripe, herald, captioned badge
**#389 — the stripe.** Negative margins pull it out to the card's own edges and back up under the border
radius, so it reads as a painted band **on** the card rather than a coloured box sitting inside one — the
card's padding is cancelled exactly. `overflow: hidden` on the card is what keeps the square stripe
corners inside the 10px radius.
**#501 — herald and acronym side by side**, a row inside the column stack so the full name below keeps
its own line. `minWidth: 0` for the same reason `#499` needed it one file over: without it a flex item
refuses to shrink below its content and a long acronym pushes the name's ellipsis out of the card.
**#503 — the caption goes inside the badge**, which answers `#488`'s "captioned by position means
captioned by nothing". Lighter and un-tracked against the figure's 800 weight, so the pill reads as
label-then-value rather than two competing pieces of text. **`color: "inherit"` with alpha rather than a
fixed grey**, because this badge sits on eight different corporate fills and takes its ink from the
stripe — the same argument `ContextualActionBar.tsx #236` makes for secondary text.

### StockRoundPanel.tsx #490 / #552 — The crown, as a drawing
`tokensPlaced` is gone: it existed only to fill the tooltip the icons needed ("Station tokens: 2 of 4
placed"), and `StationTokenRow` has always drawn that same fact as circles — **a second, worse rendering
of the row sitting beside it**, kept alive by the caption mechanism this pass removes.
The crown becomes a **tag rather than running text**, so it is skimmable in a dense table, which is the
job the glyph was doing and the only part worth keeping.
**#552:** the style now sizes a drawing rather than a word, so the type properties went with the text —
`textTransform` and `letterSpacing` have nothing to act on inside an `<svg>`, and leaving them would read
as though the crown were still a font glyph. **`color` stays and is now load-bearing**: the crown fills
with `currentColor`.

### StockRoundPanel.tsx #347 / #466 — Disabled controls compute their own look
**#347:** the unavailable state is a **neutral grey, deliberately not the primary button's colour
desaturated** — this is a state of the company, not a control waiting to become available.
**#466:** greyed *as well as* disabled. `disabled` alone leaves a button at full contrast that silently
refuses the click; inline styles cannot express `:disabled` (`Lobby.tsx #3`), so every refused control in
this file computes its own treatment. `cannotAffordNote` was **deleted** with the change — it was the red
line under a Buy button that looked enabled, and the button is greyed now. Deleted rather than left
unused: **an orphaned "here is why this is refused" style is an invitation to render a second refusal
message beside the first.**

### StockRoundPanel.tsx #393 / #409 / #392 — What rides on the card, and what does not
`TrainChips` is back, **inline in the asset row**, not in the stacked cell `#393` removed. `CapacityPill`
and `LastRoutePayout` stay out: the train **limit** is about the next purchase — an Operating Round
question — and the payout now rides in the livery stripe (`#392`).
**#447 — `last_route_revenue` is optional on the contract response**, and `gameState.ts` is explicit that
`undefined` means "this build cannot tell you" while `0` means "it earned nothing". A company that has
never operated also reports `0`, so **the honest test for "is there a run to report" is a positive
figure** — anything else shows a dash rather than asserting a $0 payout that may never have happened.
**#395:** the same `corporationPrivateCompanies` predicate applies — open, and held by *this* corporation
— but is filtered inline rather than imported, because that helper takes a whole `GameStateResponse` and
this panel is given only the roster.
**#577:** the post-purchase balance uses tabular figures so the two numbers line up either side of the
arrow rather than jittering as the quantity selector moves.

---

# The Market Move Line — `ContextualActionBar.tsx`

The dividend projection rendered on the action bar. `ZonedPrice` and `MarketMoveLine` live in that
file rather than a shared module because each has exactly one consumer, and that consumer is the bar.

### ContextualActionBar.tsx #197 — The market move line
**Format.** It read "Market move: ↗ to $82", which states the destination and hides the departure —
**the one comparison the dividend decision turns on.** It now reads `Market move: $76 ➔ $82`: both
prices, the arrow between them, in the direction the token travels.

**Colour and tooltip.** A price landing in a Yellow, Orange or Brown cell carries real rule
consequences — certificate-limit exemption, the 60% ownership cap, multi-share bank-pool buys — and the
chart has always shown that by tinting the cell. **A player reading this panel is looking at a NUMBER,
not at the chart**, so the fact was invisible exactly when it mattered: paying out to step from a
Normal cell into the Yellow zone is a different decision from stepping to any other cell, and nothing
said so.
Each price is tinted with its own zone's ink and carries that zone's rule as a tooltip.
`marketZoneForPrice` is **the same lookup the chart colours itself from**, so this panel and the board
can never disagree about which prices are Brown — see `StockMarketRenderer.tsx #196` for why the flat
text ink is a separate export from the cell gradient.
**The two prices are tinted independently**, which is the whole point: the interesting case is
precisely the one where they differ.

### ContextualActionBar.tsx #214 — The arrow carries the meaning  *[glyph superseded by #489]*
The arrows were a vertical pair (U+2B06/U+2B07) in the same neutral grey as the surrounding text.
**Directionality.** 1830's chart moves a token **along its row**: paying out steps right, withholding
steps left. A purely vertical arrow describes neither — and on a chart where vertical movement is what
**selling** does, an up arrow is actively the wrong gesture. Diagonals (U+2197/U+2198) read as "onward
and better" versus "onward and worse", which is what the two choices are.
**Colour** (still the reason the arrow is tinted at all): both arrows grey meant the two columns looked
identical at a glance and the player had to read the prices to tell which was which. Green for the rise
and red for the fall is the one convention every player already has, and it lets the choice be made
peripherally.
**The prices keep their own colours.** `#197` tints each price by its market **zone** — a rules fact —
and that must not be overwritten by the direction, which is a different fact about a different thing.
So the arrow is the only glyph the direction colours, deliberately heavier than the text around it.

### ContextualActionBar.tsx #489 — The money moved, not the cardboard
**Reported:** the diagonal arrows are confusing. Use a plain `[old] ➔ [new]`, green for an increase and
red for a decrease, ignoring the physical grid direction.

`#214` chose diagonals to describe the token's **travel**, and that is the thing this line was never
about. **A player reading a payout panel is deciding between two amounts of money.** The chart's
geometry is how the board *implements* that consequence, not the consequence itself, and spending a
glyph on it made the reader translate a direction into a value every time. So the arrow is straight
(U+2794) and says only "becomes".

**And the colour is computed from the prices, which is the part that fixes a real bug rather than
restyling one.** `rising` was `direction === "pay"` — an assumption that paying out always raises the
price. **It does not at the right-hand end of a row**, where the token cannot advance: `moves` is
false, the projected price equals the current one, and the old line rendered a confident green
up-arrow between two identical numbers. Same in mirror for a withhold at the left edge. **Comparing the
two numbers cannot produce that**, because the numbers are what the player is being asked about.
**Flat is its own case, neither green nor red.** A ceiling is not a gain, and colouring it as one is the
misreport this note exists to remove.
At a flat move both prices and the arrow are still rendered, equal, **with the reason appended** — a
line reading "$100 ➔ $100" with no explanation looks like a bug rather than a ceiling. *Which* edge was
hit is a fact about the token's travel, so this is the one place `direction` is still the right thing to
read: at a flat move the prices cannot say which end of the row was reached.

---

## Short notes and cross-references — `StockMarketRenderer.tsx`

### StockMarketRenderer.tsx #429 — The herald is bounded to the circle
`CorporateLogo` is sized to `round(tokenDiameter * 0.56)`. Without an explicit bound the default 2.4x
cap would run a wide herald out of both sides of the badge.

## Short notes and cross-references — `StockRoundPanel.tsx`

### StockRoundPanel.tsx #16 / #26 — The entire card surface is the toggle
A caret is a ~20px target on a ~300px card that is itself the thing being chosen, so the card is the
target and the question of where to click disappears. (`#396` then made the click set the card
**active**, and clicking the active card again clears it.)

### StockRoundPanel.tsx #21 — Only sources that actually hold certificates  *[superseded by #36]*
The empty pool's button was removed on the reasoning that offering it invites a rejected transaction.
`#36` kept the derivation and put the button back, disabled — right about the click, wrong about the
control.

### StockRoundPanel.tsx #25 — No holding, no Sell
Rendering a sell control for shares you do not own offers an action that cannot succeed: every size
disabled, all five struck through, a button that never enables. On eight cards where a player
typically holds three, that is five cards of dead controls. Hidden outright.

### StockRoundPanel.tsx #28 — The call to action on an unparred company
The prompt that replaces a price on a corporation nobody has started yet — the one live thing an
unparred card can offer.

### StockRoundPanel.tsx #33 — The Brown zone's multi-buy
Brown is the **only** zone where a player may take several bank-pool shares in one turn, so the
quantity selector appears there and nowhere else — offering "buy 3" in a Normal zone would offer an
action the contract rejects. The ceiling is the pool itself (`bank_pool_percentage / 10`
certificates), and it applies **only to the Bank source**, since the IPO is not what the Brown rule
relaxes.
**Honest limitation, and it is a contract one:** `BuyStock` has no quantity parameter, so buying three
shares is **three transactions**, fired in sequence and stopping at the first failure. Three log
entries is accurate — it really is three purchases. Batching would be a contract change.

### StockRoundPanel.tsx #345 — One float readout, not two
`#17` put a progress bar in the collapsed body for a good reason, and then the pill badge arrived
above it answering the same question in one line — eight cards each spending a track, a fill, a
threshold tick and a caption on a figure printed six pixels higher. The pill wins because it is
already in the header row a player reads first.

### StockRoundPanel.tsx #346 — The source is a switch, not two buttons
`#36`'s argument for keeping an empty source visible holds; what it got wrong was the **weight** — two
full-width padded buttons above Buy made choosing a source look like three primary actions rather than
one action with a setting. A segmented switch says the same in one row at a third of the height, with
the empty option struck through and its reason on hover, sitting **on** the Buy row so it reads as one
sentence. The default is handled by the effect that re-points `source` at the first stocked pool,
which runs on mount and so covers the "one is empty" case at first render.

### StockRoundPanel.tsx #356 — Nobody sells in Stock Round 1
1830 forbids any sale during the first Stock Round — allowing it would let a player park cash in a
company and withdraw it before anyone could react.
**Hidden, not disabled, and the opposite call from `#36`'s source buttons.** An empty Bank Pool is a
fact about the **board** that a buyer wants; the SR1 ban is a fact about the **rules** that cannot
change while this round lasts. **A permanently disabled control teaches the player to ignore that
region of the card, and by SR2 — when Sell becomes real — they have stopped looking.**

### StockRoundPanel.tsx #387 — No par, no market figure
The price table had been seeded from a mid-game fixture regardless of scenario, so a Zero State
corporation with `par_value: null` showed a price for a share nobody can own at a valuation nothing
set. **The market price is DEFINED as where the token stands, and a company with no par has no
token** — asserted on the card as well as in the seed and the chart's own filter (`StockMarketRenderer.tsx
#387`), because reading `market` without checking par would let any future producer put the figure back.

### StockRoundPanel.tsx #391 / #395 — The canonical rules text a private row expands to
`PRIVATE_COMPANY_CATALOG` moved to `utils/privateCatalog.ts` so the auction dashboard and this roster
describe the same company the same way. See `WaterfallAuctionDashboard.tsx #391`.

### StockRoundPanel.tsx #394 — Entity / Shares / Price
The old third column was `%`, so the header described the banks and the players identically while the
two rows answered different questions: **a player's percentage is their STAKE; the IPO's is
INVENTORY**, and what a buyer wants beside inventory is what it costs. The percentage moves in beside
the count (`7 (70%)`) and the freed column carries price.
**The two prices are different, and that is 1830, not a display choice:** an IPO share is bought at the
**par** price the president set, a Bank Pool share at the **current market** price. One price for both
rows would be wrong for most of the game.
**A player row's price is blank, deliberately, and not a dash.** There is no price at which a player's
shares are for sale, and printing the market figure there would read as an offer.

### StockRoundPanel.tsx #396 — One card holds the controls
**Reported:** showing Buy, Sell and Par on all eight cards is massive clutter.
**This reverses `#388`, left standing rather than edited away.** That note argued a control needing a
click to reveal is one the player has to remember is there — sound, and it did not weigh the
**multiplier**: eight corporations, each with a source switch, a buy button, a par ladder and a
five-way sell selector, is **roughly 160 controls on one screen.** At that density the problem is no
longer whether an individual control is discoverable — **none of them are, because the eye has nowhere
to land.**
**The reversal is narrow and `#388`'s real point survives:** the actions still render on the FRONT, in
place, under the numbers they act on. Nothing moved to a back face or a modal. Only eight copies became
one. Clicking again clears it, which is one fewer control than a close button.

### StockRoundPanel.tsx #397 — Par comes before the President's Share
**Reported:** the Par flow is chronologically backward — the par selector must render ABOVE "Buy
President's Share".
It sat below, sharing a row with the Sell selector, because both are the same **kind** of control
(`#22`) — **pairing by control TYPE is what put them out of order.** The rulebook order is the order the
player acts in: set a par price and THEN buy the certificate at it, in one motion. **The number the
button spends is now above the button that spends it.**
The sell block loses nothing: par is offered only while `par_value === null`, and a corporation nobody
has parred has no shares to sell. **The two were never on screen together.**

### StockRoundPanel.tsx #398 — The par selection is a lookup, not a value
A single shared string made every card's ladder a view of the same selection, so pressing $90 on the
PRR moved the marker on all eight. Keyed per corporation instead. (Companion to `App.tsx #398`.)

### StockRoundPanel.tsx #408 — The palette is the physical board's
The corporation colours were replaced wholesale with the physical game's, which is why comments citing
"C&O's amber" or "CPR's purple" are stale: C&O is now cyan `#5bc8e8` and CPR is brown `#7b4a22`. The
table lives in `styles/corporationLivery.ts` since `#428`.

### StockRoundPanel.tsx #410 — The historical herald replaces the acronym
26px against a stripe whose text content is ~33px tall, so it sits **inside** the existing height
rather than setting a new one — the row does not grow. The fallback keeps the old typography exactly,
so a missing file is indistinguishable from the previous design rather than a visible hole.
*(Reversed in part by `#465`: the acronym comes back **beside** the herald, not instead of it.)*

### StockRoundPanel.tsx #418 — The SR1 ban reached the selector, not the button
`#356` applied `sellingForbidden` to the **size selector** and stopped there, so in SR1 the strip of
10/20/30/40/50 vanished and a live "Sell 10% Bundle" button remained underneath it, wired straight to
`onSellShares`. **The ban was visible and not enforced, which is the worst of both.**
**Disabled, not hidden, and deliberately the opposite of `#417`.** The discriminator is whether the
player can ever act here: outside a Stock Round the answer is no and the controls go; **in SR1 selling
is a real action of this very panel, barred for one round and legal in every round after**, so a
disabled button carrying the reason teaches a rule the player will need next round. Same argument the
sell-size list already makes. **The reason is on the button, not only in a tooltip** — the label itself
changes.

### StockRoundPanel.tsx #423 — Two renderers of one fact drift apart
The precedent `#424` cites: this file has been bitten before by a second component that merely *looks
like* the one it duplicates. Hence `StationTokenRow` is shared rather than reimplemented.

### StockRoundPanel.tsx #424 — The capacity, drawn
**Reported:** replace the plain "n of 4 stations placed" text with the visual token row the action bar
already uses.
`2/4` is a count, **and a count is the least of what a player wants here.** The shared row answers three
questions the fraction cannot: which tokens are spent, where the home one sits, and — the one that
decides a purchase — **what the NEXT one costs.** A corporation with two placed is looking at $100 for
its third, and `2/4` does not say so.
**The same component, not a second one that looks like it** (`#423`). `stationTokenSlots` is the same
derivation the action bar feeds it.
**The inks are the card's, not the bar's.** `StationTokenRow` takes its ring and caption colours as
props precisely because it sits on two surfaces — the bar's corporate livery and this card's light
paper — and the bar's near-white ink would vanish here.

### StockRoundPanel.tsx #428 — One livery table
See `StockMarketRenderer.tsx #428`: the eight corporation colours live in
`styles/corporationLivery.ts`, replacing three hand-kept mirrors.

### StockRoundPanel.tsx #446 — Floated companies sorted to the front  *[superseded by #464]*
Right about the order, wrong about the moment: **a Stock Round is where a player USES these cards, and
buying is what causes floats — so the act of using the screen rearranged it under them.** `#464` holds
the order and recomputes it only at an Operating Round boundary.

### StockRoundPanel.tsx #448 — Nine certificates, not ten
**Reported:** the maximum share count for the IPO and player tables should be 9 — there are physically
nine certificates: one 20% President's Certificate plus eight 10% shares.
`percentage / 10` counts **percent blocks**, which is ten of them, so a full IPO read "10" for a stack
of nine pieces of card — **and the extra digit is what clipped the column.**
`certificateCount` already knew this and the player rows had used it all along; **the two bank rows were
doing raw division beside them, so one table was counting in two different units.**
**While the presidency is unsold the 20% certificate is still in the IPO**, so the IPO counts as holding
it — `president === null` is exactly that test, and it is why this cannot be a constant 9. A President's
Certificate can never reach the Bank Pool (a president must dump the presidency before selling out), so
that row is never a double certificate.

### StockRoundPanel.tsx #465 — The acronym comes back
`#410` replaced the acronym **with** the herald, and the trade was not even: **a herald is unmistakable
once you know it and unreadable until you do.** Eight historical marks a new player has never seen are
eight things to learn before the roster can be scanned, and the full name is too long to serve as the
quick label — it is what you read second. **"PRR" is what a player says out loud** and what every other
surface calls the company.
**Beside, not instead.** `CorporateLogo`'s text fallback still renders the ticker when a file is
missing, which would double it — **only in the failure case, and a doubled ticker is a better failure
than a nameless card.**

### StockRoundPanel.tsx #502 — The `$`
Treasury has carried one since it joined this row (`#489`) and Market and Last Run did not, so one line
held three figures in dollars of which only the rightmost said so. **The dash keeps its bare form
deliberately — "$--" would put a currency on an absent value.**
