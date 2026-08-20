# Routing & Pathfinding — Route Drafting and Validation

The manual route builder, waypoints and bridging, revenue centres vs hexes, train capacity, the
auto-router, and what is deliberately left to the contract.

Anchors are `<source file> #<N>`. Search the number.

---

## Where authority lives

### App.tsx #11 — Manual route points, and what the client may check
`ExecuteMsg::RunManualRoute` validates a declared path step by step — connectivity, the
corporation's own station, rival token blockades, and the train's distance budget. Batch 3 replaced
its original `hex_path: string[]` with `path: RouteWaypoint[]`, so a stop can name **which** station
on a two-city hex it means.

The client-side checks are worth having and are explicitly **not** a second rulebook: they catch a
bad path before it costs a signature and a gas fee. Everything a true validation needs — whether each
hop follows laid track with a connecting edge, whether the path touches the corporation's own
station, whether a rival blockade sits in the way — is checked **on chain** and deliberately not
reimplemented. A second copy of those rules in TypeScript could only drift from the authority, and
the contract rejects a bad route cleanly with a named error the Action Log already surfaces.

### App.tsx #202 — Auto Route is a drafting tool
The button had been disabled since Audit G-13 removed `ExecuteOperatingRound`, with a tooltip
explaining that the contract's own pathfinder has no message reaching it. **True of the contract and
irrelevant to the button**: a player asking for a route to be drawn is asking the UI to pre-fill the
manual builder, which needs no chain at all. The result leaves through the same `RunManualRoute` the
player could have clicked out by hand.

Explicitly a **suggestion** — `autoTraceRoute #0` lists what it does not check, and every one of
those remains `pathfinding.rs`'s. Named "Auto Route" rather than "Best Route" for the same reason
`#186` refused "Calculate BEST Route": a client-side claim of optimality the contract disagreed with
would be worse than no button.

---

## Drafts: one per train

### App.tsx #275 — One route per train, keyed by train
**Reported:** the router runs a single train even when the corporation owns three.

`routePoints` was one array, so the app could hold exactly one route at a time — not what a 1830
corporation does. It runs every train it owns in one turn, each on its own route, and the dividend is
the sum.

**Keyed by index into `owned_trains`, not by model.** That is the whole subtlety: a corporation with
three 3-trains has three trains, and "the 3-train's route" does not identify any of them.
`runnableTrains` had deduplicated the roster on the reasoning that "two 3-trains are one CHOICE" —
correct while the question was which train to validate **one** route against, wrong the moment the
question became which train this route **belongs to**.

A `Record` keyed by that index rather than an array parallel to the roster: the roster changes under
this (a train rusts, one is bought mid-turn) and a parallel array would silently reassign every route
to the wrong train. Stale keys are ignored when drafts are read back.

`#275` (pricing): one memo prices the whole roster rather than a single `routeBreakdown`. Each entry
is what `RoutePlannerPanel` renders as one row and what `handleRunTrains` dispatches as one message,
so the panel, the total and the dispatch cannot disagree about which routes count.

`#275` (overlays): one overlay per drafted train, so the board shows the whole turn at once rather
than whichever route was drawn last. **The colour is shared** — all of them are this corporation's
routes, so all wear its colour (`#254`); distinguishing them by hue would invent a second meaning for
a channel that already answers "whose turn is this". The **active** train's route is the one being
edited, and the panel's row highlight says so.

### App.tsx #275 — One message per train
`RunManualRoute` carries **one** `path`, because it declares one train's run. That is the contract's
shape, not a limitation to work around: each route is validated on its own, and a rejected third
route does not undo two accepted ones.

Awaited in sequence rather than fired in parallel — the sandbox reducer is synchronous through a ref
(`#265`), and on a live chain sequential signing is what the wallet expects anyway.

**Invalid drafts are skipped, not refused.** The panel's total already excludes them and says so;
blocking the whole dispatch because one of three routes ends on a town would make the good two
hostage to the bad one.

### App.tsx #280 — The best set, chosen jointly
`#275` drafted one train at a time, biggest first, handing each the hexes its predecessors took. Two
things were wrong, and both are now `assignRouteSet`'s (`#4` and `#7` there):

- **It barred whole hexes.** Two trains may legally cross one hex on different curves, and may reach
  the two separate stations of an OO tile. **Occupancy is per RAIL now.**
- **It decided in order.** The best route for the 5-train may be the only route the 3-train could
  have run, and a greedy pass cannot see that because it commits the 5-train before looking at the 3.
  The set is chosen jointly against the combined payout.

### App.tsx #286 / #493 — Arriving at the step means actually drafting
An empty table on arrival is worse than a drafted one — the tracer's answer is the better starting
point for most players and an expert can edit it.

Guarded **per corporation** rather than per render: the tracer is a search, and re-running it after
every board change would overwrite a route the player has since edited by hand. One draft on arrival,
then it is theirs — and `AutoRouteButton` is how they ask for another.

`#493`: the `routeBuildMode !== "auto"` guard is gone with the toggle. It only ever skipped the draft
when the player had switched to a mode that behaved identically.

### App.tsx #266 / #493 — There is no auto/manual mode, only a draft
`routeSelectMode` stays as the **canvas** flag — whether map clicks are routed to the builder.
`routeBuildMode` said which of the two drafting tools the panel's toggle showed as chosen, and `#286`
argued about which position it should open on. The honest answer turned out to be that **neither
position did anything**: the map is editable for the whole sub-phase either way. What `#286` was
really defending is kept — the step still drafts on arrival.

**Editing a draft makes it yours.** Clicking a hex used to flip the toggle to "Manual", because a
control still reading "Auto-Route" would be crediting the tracer for a path the player had changed.
With no toggle there is nothing to correct.

`#266` (engagement): entering the step **engages** the builder. The panel is on screen for the whole
sub-phase, and a visible builder whose map clicks go nowhere is worse than no builder — the player
clicks a city, nothing happens, and the only clue is a control they already appear to have selected.
There is nothing else to click the map for during Run Routes.

`#266` (messaging): **no success message.** This used to set "Auto Route drafted 5 hexes worth $180.
Edit it by clicking hexes, or clear it and build your own." — a red string, on the happy path,
restating the hex chain and the value the panel renders two rows above it, then explaining the
panel's own controls. Every fact in it is now on screen as a fact rather than as a sentence about
one.

### App.tsx #33 — Route mode must be forced off when the step ends
Hiding the toggle is not enough: route mode also rewires the Rail Map's click handling, so a mode
left on when its phase ends would keep swallowing tile-lay clicks with no visible control to turn it
back off. Forced off (and the half-built path dropped) the moment the Routes sub-phase ends, in the
same place the flag lives rather than in the bar that renders the switch.

---

## Waypoint rules

### App.tsx #243 — The waypoint carries the label, not the name
**Reported:** auto-route prices a route correctly and manual route resolves to $0.

This stored `info.hexLabel` — `describeHex`'s **display** string, "New York (G19)" — as the
waypoint's label. Two things followed, only the first visible:

- **It priced at zero.** `sandboxRouteBreakdown` looks each stop up in a table keyed on the
  **canonical** label, so every stop missed and the route totalled nothing. `autoTraceRoute` builds
  its labels from `STATIC_BOARD_HEXES` and priced identical routes correctly — precisely the reported
  asymmetry, and the reason it looked like two revenue calculations when it was one being fed two
  kinds of string.
- **It would have been rejected on chain.** The same value goes into `RunManualRoute`'s
  `path[].hex`; the contract resolves that against its own hex table.

`boardLabel` is the identifier (`#242`). `hexLabel` stays the display string and is still what the
feedback messages quote, because "Altoona (H12) has no track" reads better than "H12 has no track".

### App.tsx #186 — A waypoint needs track
Any hex could be added, including bare ground the corporation has never built on — so a "route" could
be drawn across empty prairie, priced, and submitted. The adjacency check refuses a **disconnected**
chain; it has nothing to say about a connected chain of hexes with no rails on them.

**Preprinted track counts:** the gray hexes and the landmarks ship with rails the board draws and
trains may run on, so `liveEdgesForHex` — which reads a laid tile's rotated mask **and** the
preprinted geometry — is the right test rather than "is there a tile record".

### App.tsx #256 — A route runs between two paying stops
**Reported:** routes should start and end at a city, town or red off-board hex rather than anywhere
the player happens to click.

1830's definition of a route is a run between two **revenue centres**, with any amount of plain track
between. The builder enforced only that each click had track on it, so a route could begin and end on
bare connectors — which the contract then refused for failing the two-centre minimum, after the
player had drawn the whole thing.

**The first click is refused outright** when it is not a revenue centre: there is no ambiguity about
what it is, and refusing costs the player one misplaced click rather than a whole path. **The last is
left to the readout and the Run button** — it cannot be enforced on click, because every intermediate
click is momentarily "the last" and refusing plain track mid-draw would make it impossible to cross
any.

### App.tsx #264 — A town is not a terminus
This used to test `hexStopValue > 0` — "does this hex pay anything" — which is the right question for
**revenue** and the wrong one for **termination**. Towns pay, and 1830 does not let a route begin or
end on one: they are passed **through**, adding their value to a run between two cities.
`isRouteTerminusHex` asks the question that actually applies.

### App.tsx #276 — The gap between two stops is not a decision
**Reported:** manual routing forces a click on every plain track hex between two cities.

The old rule refused any non-adjacent click outright — "route points must chain through neighboring
hexes" — a true statement about routes and the wrong thing to ask of a player. The chain has to be
**connected**; it does not have to be **typed in one hex at a time**, and on a built-up board
nineteen of every twenty clicks had exactly one legal answer.

`bridgeWaypoints` walks the live track between the two, **preferring plain track over a shortcut
through some third city** (`#5` there — an unasked-for city costs both revenue and a stop of the
train's capacity).

**A failed bridge is still refused, and says so.** Two hexes with no rails between them are not a
route, and filling that gap with a straight line would be the class of plausible fiction this codebase
has deleted twice already.

### App.tsx #624 — A route cannot be longer than its train
**Reported:** the manual route selector lets me visually exceed the actual length my trains can run.

Every other rule about a waypoint was enforced on the click — it needs track (`#186`), it cannot
repeat a hex, the first one has to be a terminus (`#256`/`#264`) — and the train's own capacity was
not, even though it is the most basic of them.

**Why a refusal and not a warning.** `exceedsMaxDistance` already exists on the draft and already
greys the row, so the state was being **reported**. The report is that reporting is too late: by then
the player has drawn a route they now have to unpick, and the drawing is the part that took the
effort.

**Revenue centres, not hexes.** A 3-train runs three **stops** and may cross any amount of plain track
between them, so the count asks each hex whether it pays — which is what `autoTraceRoute` and the
contract both measure, and what `maxDistance` is expressed in. Counting hexes would refuse perfectly
legal long runs across empty track.

**The bridge is counted too.** `bridgeWaypoints` can fill a gap through a town or a third city, so a
single click may add several paying stops. Checking the **result** rather than the click is what
catches that, and is why this is applied at `commit` rather than at either append site.

### App.tsx #474 — The token rule, which was not checked at all
A route must pass through a city this corporation holds a token in. Nothing enforced that:
`handleRunTrains` filtered on revenue, distance and terminus, so a run drawn entirely across another
company's network priced up and dispatched, and the contract refused it after the fact.

**Any token, anywhere on the run** — "the home hex" is the wrong rule and gets more wrong as a
corporation places more tokens. The acting corporation's station tokens are derived once as `(q, r)`
pairs rather than looked up per draft: every train's route is judged against the same corporation's
tokens, and re-finding the company inside the map would make the rule look per-train when it is
per-corporation.

`#474` (ordering): reported **before** the terminus hint, because a tokenless route is wrong about
**where** it runs rather than about how it ends — telling the player to extend it would send them
further in the wrong direction.

### App.tsx #232 — Dependency arrays for the click handler
`mapGrid` joins for `#186`'s track check — a stale closure would judge a waypoint against the board
as it was before the last tile lay, and refuse a hex the player has just built on.

The draft and the active train are read through **refs** (`#275`), so neither joins the list: they
change on every click, and a handler identity that changed with them would rebuild the canvas's click
prop mid-draw. The **era** is not needed either — `#264` replaced the value test with an archetype
test, and whether a hex holds a city does not change with the phase.

---

## Pricing the draft

### App.tsx #234 — Live preview of what the stops are worth
Recomputed as the player clicks, which is the whole point — a number that only appears after dispatch
cannot be used to compare two candidate routes. Below two points there is no route to price, and
showing "$0" for a single click would read as "this city is worthless" rather than "you have not drawn
a route yet".

### App.tsx #285 — The stop count is the stop list
**Reported:** a 2-train running City → Town → City reads "2/2 stops" in Manual mode and can be
submitted, while Auto-Route rejects it.

The arithmetic was audited across the whole board before changing anything, and it holds:
`sandboxRouteBreakdown` counts every hex that pays, towns included, so that route reports three stops
in both modes and no reachable hex prices at $0. The manual bridge includes the town too. **There was
no divergence in the counting.**

**What there was is a hole one level up**, producing exactly the reported symptom — a route that
cannot be blocked: `maxDistance` comes from `MOCK_TRAIN_CATALOG`, and a model the catalog does not
know returns `undefined`. The old test read `maxDistance !== undefined && centres > maxDistance`, so
an unrecognised train had **no capacity at all**: every route passed, however many stops it visited,
and the readout printed a bare count with no limit beside it.

The cap now **falls back** rather than vanishing. An unknown train is treated as the smallest real
one, the conservative direction: it can refuse a route the contract would have allowed, and it cannot
wave through one the contract will refuse.

**And the count is now `stops.length`** — literally the list the panel renders. The two were already
equal by construction, and equal by construction is a thing that stops being true when someone edits
one of them.

### App.tsx #156 — `routeHopCount` is gone
It counted hops between selected hexes and was compared against a train's number, the classic 18xx
misreading: a 2-train is limited to two **revenue centres**, not two hexes of travel.
`routeBreakdown.centres` replaced it as the capacity figure and `routeBreakdown.hexes` as the "how far
did I click" figure. Deleted rather than left unused so nothing can quietly start comparing against it
again.

### App.tsx #492 — The committed total, recorded from what was dispatched
`utils/dividendStep.ts #492`: what this corporation actually committed at the Run Routes step, summed
across every train it dispatched. `last_route_revenue` cannot hold it — `RunManualRoute` is one
message per train and each write replaces the last — so the total is kept in the shell and handed to
the Dividends step.

**Keyed by corporation** and cleared whenever the acting one changes. The protocol id is carried
rather than assumed: an optimistic sub-phase advance can land a render where the queue has moved on,
and a total credited to the wrong corporation would be worse than none.

Recorded from the very list that was just dispatched rather than recomputed from the drafts — the same
figures the planner priced and the loop sent, so the number the Dividends step spends is the number
the player watched being assembled. `runnable` has already excluded every invalid draft, so it cannot
count a route that was never sent.

`#492a`: `resetRouteRevenue` marks the **first** `RunManualRoute` of a turn's batch so the reducer
starts its per-turn sum from zero instead of adding to the last turn's. Flagged in the dispatch loop
rather than inferred in the reducer, because the loop is the only thing that knows where a turn's
batch begins — and set **inside** the loop rather than from the index, since a draft with fewer than
two points is skipped and would otherwise consume the flag without dispatching anything.

### App.tsx #198 — The dividend was always the same $180
`revenue_amount` was `MOCK_DECLARE_DIVIDENDS_REVENUE` — a fixed constant left over from before routes
were wired — so whatever a corporation had just earned, it declared the mock figure. The panel
directly above the buttons showed the **real** revenue and its real per-share split, and then the
button sent a different number. **Two figures for one decision, three inches apart, and the one the
player could see was not the one that travelled.**

It reads the same field the panel renders from, so the panel and the message cannot disagree. Read
**inside** the callback rather than closed over from the derived value further down the component:
that value is declared after this callback, and naming it in a dependency array here would evaluate it
before its own initialiser had run.

`#492` (pairing): and the **same committed total** the panel is quoting. Without it a multi-train
corporation would see its real total, click Pay, and dispatch the last train's revenue.

### App.tsx #373 — The route hover cursor: one number, three surfaces
The shared cursor lives in the shell because all three consumers are children of it and none is the
parent of the others — the map is in one pane, the corporation strip in the action bar, the Route
Planner in a third. Lifting it is the only place they meet.

**Deliberately not persisted and not in the undo snapshot** (`#310`'s rule is about state the
**dispatch** path writes). A hover cursor describes where the pointer is, which is not part of the
game. `null` is the resting state and every surface clears to it on leave.

**App.tsx #373 / App.tsx #495**: the renderer has supported `primary`/`muted` emphasis since `#373` — heavier pen,
brighter glow, others faded to 0.32 alpha — and `highlightedTrainIndex` has been fed by the planner
rows and the train chips the whole time. **Nothing connected them**, so hovering a chip lit its own
row and left the map unchanged: the mechanism existed at both ends and not in the middle. `normal`
when nothing is highlighted, so a board with no cursor draws exactly as before.

### App.tsx (Routes → Dividends) — Withhold at the Routes step, decide at Dividends
The dividend decision belongs to the Dividends sub-phase, which is the very next step — so the revenue
is withheld into the treasury at Routes and paid out (or not) there. Declaring a payout from the
Routes step would make the separate Dividends buttons meaningless.

---

# What a train can do inside one hex — `utils/trackSegments.ts`

### trackSegments.ts #0 — A hex is not a node
Every path-walking surface in this app — the network reach that gates tile laying, the Auto-Route
tracer, the manual waypoint bridge — asked the board the same question and got the same wrong answer:
**"does hex A carry rail toward hex B, and B back toward A?"** That is `liveEdgesForHex` on both sides,
**and it treats a hex as a NODE through which everything connects to everything.** Most hexes are, so
the answer is usually right. On the ones that are not it is silently and badly wrong:

- **Tile #20 is two separate straights** — edges 0–3 and 1–4, authored as two rails that cross visually
  and do not touch. The edge test reports all four edges present and therefore all four mutually
  reachable, **so a corporation whose track meets edge 0 was told it reaches whatever sits beyond edge
  1.** Confirmed on the real board: a three-hex patch with #20 in the middle reported the far hex as
  networked across two rails that never meet.
- **The OO tiles and the double-city tiles have the same shape** — two stations, each with its own pair
  of edges, no path between them. **New York (#54/#62) is the loudest case:** its two spurs are
  physically disconnected, and `hexCanvasPrimitives.ts #226` already had to fix the ROUTE GLOW for
  exactly this reason. **The connectivity layer never got the same treatment.**

So this module answers the question a hex actually poses: **entering at edge E, which edges may I leave
by, and along WHICH rail?** Both halves matter — the first is connectivity, the second is occupancy.

### trackSegments.ts #1 — The answer already existed; nothing consumed it
`pathsForTraversal` in `TileGraphics.ts` has resolved exactly this since `#217`: it returns the authored
rail(s) joining two edges, or `[]` when they are not joined, **and it already knows that two hub spokes
only connect if their interior ends MEET.** The route overlay has used it for several passes to stroke
the one rail a train runs along. **This module is that primitive lifted to the whole board — no new
geometry is invented here; the geometry was correct and only the renderer was asking.**

### trackSegments.ts #2 — Where there is no artwork, everything connects
Landmarks carry track recorded as a bare **edge list** with no per-rail structure, so there is nothing to
be precise with and those fall back to the old behaviour. **That is the conservative direction for
connectivity — it can only report MORE reach, never less, so it cannot hide a legal move — and it is
stated here rather than left implicit, because it is the one place this module still gives the answer
`#0` calls wrong.** Closing it needs that table to gain rail structure, **which is a data change rather
than a logic one.** The same fallback covers a hex whose tile id is absent from the artwork catalog: **a
catalog gap should not make the board less connected than it is.**

### trackSegments.ts #484 — A red off-board area is a terminus, not a junction
**Reported:** the network calculator treats red off-board areas as traversable, so a network that enters
one is granted legal placement on every other hex touching it.
It did, **and `#2` above is where it came from.** Off-board track is a bare edge list, so it fell through
to the everything-connects fallback — **and that fallback is not conservative at all on a red hex,
because the surplus reach is not a longer path through real rail. It is a WORMHOLE.**
Chicago (F2) prints stubs on edges 0, 1 and 5 — real neighbours F4, E3 and G3 — **so a corporation whose
rail met F4 was told it reached E3 and G3 too, and the veil lit builds on the far side of a hex no train
may pass through. Every red zone has the same shape: A11 spliced B10 to B12, K13 spliced J14 to J12, B24
spliced B22 to C23, J2 spliced J4 to I3. Five false junctions, each fusing two unrelated networks.**
**1830 is unambiguous here.** A red area is a revenue destination where a route ENDS. A train runs in and
stops. **It never runs out the far side, and two pieces of track that both meet the same red zone are not
thereby connected to each other.**
**So there is no traversal — not a restricted one, none.** `null` for every (entry, exit) pair, **which is
the identical answer this function already gives for two curves that never touch.** Stating it once here
reaches every caller.
**The hex itself is still reached, and that distinction is the whole fix.** This function answers "may I
pass THROUGH", not "may I get here" — `neighbourAcross` is what admits a hex to the network and is
untouched, **so a red zone still joins the network, still renders as reached, and still counts as a
destination worth running to. What it no longer does is hand out the hexes behind it.**
Derived from the board's own `type: "RedOffboard"` discriminator rather than from a label table: **both
currently name the same seven hexes, and keying off the type field means they cannot drift into
disagreeing — which would show up as a lay the veil offers and the click handler then refuses.**

### trackSegments.ts #3 — A segment key, because a hex id could not be one
1830 forbids two of a corporation's trains from running over the same **track**. The previous drafter
approximated that by barring whole **hexes**, documented at the time as deliberately stricter — **safe
for a suggestion, but it forbids the commonest legal shape on a busy board: two trains crossing one hex
on the two arms of a crossover, or reaching the two separate stations of an OO tile. On a late-game map
that approximation costs real revenue.**
A segment key is **`q,r#index`**, where `index` is the authored rail's own position in its hex's artwork.
**Two trains sharing a hex are fine; two trains sharing a `q,r#index` are not.** A hex with no per-rail
structure reports `q,r#*` — **one shared identity for the whole hex, which reproduces the old exclusion
exactly where nothing better is knowable.**

### trackSegments.ts (traversals) — `null` is the whole point
`traversalSegments` returns the authored rails joining two edges, **or `null` when the two are not joined
by continuous track: that is the answer `liveEdgesForHex` cannot give, and the reason `#0`'s bug
existed.** `traversalsFrom` is **strictly port to port** — an exit appears only when an authored rail is
found, **so two disconnected curves on one tile yield two disjoint answers rather than one junction.**
**What it does NOT check, and a previous version of this comment wrongly claimed it did:** whether
anything lies beyond the exit. The both-sides rule lives in `neighbourAcross` **and has to stay there —
a tile lay extends the network across an edge with nothing behind it yet, so a caller looking for build
sites needs the exits WITHOUT that filter. Applying it here would have hidden every extension on the
board.**
New York is authored outside the printed-graphics catalog (`#229`), **so it is asked for explicitly
rather than falling through to "everything connects" — which is exactly the claim its two disconnected
spurs must not make.**

---

# Where a corporation may build — `utils/trackReach.ts`

### trackReach.ts #0 — A hint about reach, not a ruling about legality
18xx.games dims the board during a tile lay and lights only the hexes you may build on. **That is a
genuine usability feature rather than decoration: 1830's board is 100-odd hexes and a corporation can
usually build on three or four of them, so without it the player's first move is to work out where their
own network ends — every turn, by eye.**
**What it does not answer, and must never grow to:** whether a given tile fits (upgrade topology, colour
tier, path preservation, the "B"/"NY"/"OO" set — `execute_lay_tile`'s, mirrored for the picker by
`sandboxTileLegality`); the one-tile-per-turn rule or a private's extra lay; token blocking (**a city
whose slots are full stops a ROUTE, not a lay**); or whose turn it is.
**The consequence of this file being wrong is a hex that is dimmed when it should not be — an
inconvenience — rather than an illegal action being accepted. That asymmetry is why the fallback opens
the board up rather than closing it down.**

### trackReach.ts #1 — Connectivity is checked from both sides
Two hexes are joined when A carries a live edge pointing at B **and** B carries the matching edge pointing
back — the same rule the tracer uses, **and for the same reason: a dead-end stub (Richmond's single edge,
New York's two disconnected spurs) otherwise reads as connected to whatever sits beyond it.**

### trackReach.ts #2 — A corporation with no token is unconstrained
A corporation that has floated but not placed its home token has no network, **so a strict reading would
return the empty set and the UI would dim the ENTIRE board with nothing lit. The player would be told,
wordlessly, that they may not build anywhere — which is both wrong (their first lay is the home hex) and
indistinguishable from a broken feature.** The same applies before the first `GetGameState` resolves.
So "I do not know where this corporation's network is" returns **unconstrained**, and the caller leaves
the board undimmed. **The contract remains the authority either way; the only thing lost is the hint.
Erring the other way would take the board away from the player over missing data.**

### trackReach.ts #3 — A tile lay extends a route; it does not touch a hex
**Reported:** the veil lights every hex surrounding the corporation's station.
It did, because this was `boardNeighbours` — all six neighbours of every network hex — on the reasoning
that "a tile lay EXTENDS a network, so adjacency is the test, not connectivity."
**The first half of that is right and the conclusion does not follow.** The new hex has no track, true —
**but the lay still has to join the network, and a network only offers a join where its own track ENDS AT
AN EDGE.** PRR on H12 (Altoona, printed track on edges 0 and 3) can extend west to H10 and east to H14
and nowhere else: **the other four sides are blank cardboard with no rail reaching them, so a tile laid
there would touch Altoona without connecting to it.**
**Six lit hexes where two are legal is not a small over-count. It is the feature inverted** — the player
is told to consider four placements the contract will reject, on the one screen whose whole job is to say
which placements are worth considering.
**The test is one-sided, and that is the difference from the network walk.** Joining an EXISTING network
needs both hexes to carry matching rail; **extending it needs only the network side to offer an edge,
because the tile about to be laid supplies the other half. Using the two-sided test here would light
nothing at all on a fresh board.**

### trackReach.ts #4 — A network follows rails, not hex adjacency; and the network is shown, not hidden
**Reported:** legal network expansion bleeds across the disconnected tracks on tiles that carry more than
one.
**The cause is one line further down than it looks.** The walk was hex-to-hex, which **treats a hex as a
NODE where everything meets — true of most tiles and false of exactly the ones this matters on.** Measured
on the real board before the fix: a three-hex patch with #20 in the middle reported the far hex as
networked **across two rails with no connection between them.**
**The walk is over (hex, arrival edge) states now.** Arriving by one edge only licenses the exits that
edge actually joins. **A crossover is entered twice, once per straight, and each visit carries only its
own onward reach.**
**The station hexes themselves are unrestricted, and that is not a shortcut:** a route starts AT a token,
inside the city, **so every rail leaving that city is available to it. There is no arrival edge to
constrain a start.**
**#4 (the veil) — reported:** the board dims aggressively and hides the corporation's own network. The
first cut veiled everything except the legal targets, **which is the obvious reading of "dim what you
cannot act on" and the wrong one.** A player choosing WHERE to extend is reasoning about the route the
extension would join — **so dimming exactly that leaves the legal hexes lit and the reason for choosing
between them in the dark.** Three tiers: the **network** at full brightness, the **extensions** lit and
glowed, everything else receding. Returned from **one walk**, **or the two halves of one picture would
disagree about where the network ends.**

### trackReach.ts #483 — A network ends at PORTS, not at hexes
**Reported:** the calculator traces connectivity through discontinuous track on a hex, so two separate
curves are treated as joined and illegal placements are offered.
**`#4` fixed HALF of this.** The BFS was made strict — a crossover entered on one straight no longer
licenses the other — **but what it produced was still a set of HEX keys, and everything downstream then
asked that set the hex-as-a-node question all over again:**

- **The extension lookup** took a network hex and offered a build across EVERY live edge of it. **So a
  corporation whose rail reaches edge 0 of a #20 crossover was offered lays beyond edges 1 and 4 —
  exactly the reported bug, one layer below where the fix was applied.**
- **The rotation filter** (`sandboxTileLegality`) did the same for rotations: it asked whether a
  neighbour was in the network and carried rail to the shared edge, **which is true of the far arm of a
  crossover the corporation cannot reach.**

**The strictness was being computed and then thrown away. A hex key cannot express "reached, but only on
this rail", so any consumer holding one has to re-derive the missing half — and both of them re-derived
it wrongly.**
**A port is the missing value:** `"q,r:edge"`, meaning the corporation's own track reaches the inside of
this hex AT this edge. **Produced by the same walk that produces the hex set, so the two cannot
disagree.**
**It includes edges with nothing beyond them, deliberately.** The hex set only grows across a two-sided
join (`#1`), because a network cannot flow into bare cardboard — **but bare cardboard is exactly where a
tile gets laid, so the port survives where the hex does not.**
`reachableNetwork` is **exported because two features need the same walk and must not disagree about it**
— the tile-lay veil grows this set by one hex, and station placement tests membership directly. **A second
BFS with its own subtly different adjacency rule is exactly how "the board says I can build here but the
token button says I cannot" happens.**
`connectedNeighbours` is **deleted rather than left unused so nothing can quietly start calling the old
model again.**

---

# The Auto-Route tracer — `utils/routeAutoTrace.ts`

### routeAutoTrace.ts #0 — A client-side SUGGESTION, not an oracle
The Auto Route button had been disabled since Audit G-13 removed `ExecuteOperatingRound`, on the reasoning
that the contract's own pathfinder no longer had a message reaching it. **That reasoning is correct about
the CONTRACT and wrong about the button: a player asking for a route drawn for them is asking the UI to
pre-fill the manual builder, which is a client-side convenience that needs no chain at all.** The result
travels to the contract as the same `RunManualRoute` the player could have clicked out by hand.
**The line this must not cross — `pathfinding.rs` remains the only authority on what a legal route IS.
The list below is deliberately not a to-do:**

| not checked | why it belongs to the contract |
|---|---|
| **Token access** | a route must run through a city the corporation has a token in, and may not pass through one whose slots are full of other companies' tokens. This starts AT a token, which satisfies the first half by construction, **and ignores the second entirely.** |
| **City slots** | a two-city hex is one node here. Which station a train reaches is `city_node`'s question **and this never sets one.** |
| **Train count** | the multi-train ALLOCATION problem is approximated (`#7`), not solved. |
| **Overlap** | two trains may not reuse the same track SEGMENT. `#4` originally barred whole HEXES — **stricter and therefore safe for a suggestion, but not the rule and not to be mistaken for it.** |

### routeAutoTrace.ts #1 / #6 — The walk follows rails, and spends them
**Connectivity is checked from both sides** — checking one side only is **the classic 18xx map bug: a
dead-end stub reads as connected to whatever happens to sit beyond it, and the tracer walks off the end of
the rails.**
**#6 — two changes, and they are the same change seen from two sides.**
**It walks (hex, arrival edge) states.** The old walk treated a hex as a node where all its rails meet;
**on #20, the OO tiles and New York that is false, and the tracer would happily route a train in one
straight and out the other.**
**It spends SEGMENTS, not hexes.** The whole-hex approximation **forbids the commonest legal shape on a
built-up board**, so occupancy is keyed on the rail itself.
**A route also may not reuse its own track**, which falls out of the same set. The old `visited` hex set
enforced a **stronger and slightly wrong** version: **a route may legally touch a hex twice by different
rails, and 1830 pays it once either way**, which the pricing already handles by deduplicating.

### routeAutoTrace.ts #5 / #9 — Clicking two cities should not mean clicking nine hexes
**Reported:** manual routing forces the player to click every plain track hex between two cities.
It did, because the builder's only rule was "the next point must be a DIRECT NEIGHBOUR". **That rule is
correct about what a route is and wrong about what a player is doing when they draw one. Nobody choosing a
route is choosing the plain track; they are choosing the STOPS.** A five-stop route across a built-up
board was twenty clicks, **nineteen of which had exactly one legal answer.**
**It prefers plain track, and that is the interesting part.** The shortest path by hex count is not always
the one the player meant: **a bridge that happens to pass through a third city silently adds that city's
revenue AND spends one of the train's stops, neither of which was asked for.** So the search is weighted —
crossing a revenue centre costs far more than crossing plain track. Where there is no alternative the
centre IS included, because the train genuinely stops there, **and it then appears in the stop list with
its value. What must never happen is a stop appearing in the total that the player cannot see.**
**The manual click still wins** — the bridge only fills gaps the player left. `avoid` is the hexes already
on the route: **a route is a simple path, so a bridge may not loop back through one — without this,
clicking a city the route already passed through would produce a chain that visits a hex twice and prices
it once, and the two would disagree.** `null` for no connected path, **which the caller reports rather
than papering over: inventing a straight line across the board is exactly the class of plausible fiction
`#216` deleted.**
**#9 — the bridge walks rails too.** *Reported:* with tile #56 on G7, the router bridges H8 to F6 across
two curves that do not touch. `trackSegments.ts #0` fixed this class of bug in the network reach and in
the auto-tracer, **and this function was missed** — it kept its own hex-to-hex Dijkstra. **Reproduced on
the real board with the reported hexes before the fix, which is also why the earlier audit came back
clean: the AUTO tracer already asked the strict primitive. Only the manual bridge did not, so only manual
routing hallucinated — and the previous report had named the auto-router.**
The walk is over (hex, arrival edge) states now, **and the visited set is keyed on the state rather than
the hex, because one hex may legitimately be visited twice by two different rails.** `cameFrom` stores the
**predecessor STATE's key** — the split is load-bearing: **an earlier cut stored each node under its own
key and walked the chain back through it, which reads a node's predecessor as itself and returned `null`
for every connected pair on the board.**
The destination's own value is **not charged** — the player asked for it, **so its cost is not a reason to
route around it.**

### routeAutoTrace.ts #7 / #8 — The best set, and why the optimiser must not be able to lose
**#7 — reported:** auto-route naively assigns routes to the largest train first, missing optimal
multi-train sets. It did, **and the note that shipped it admitted as much.** The greedy order was
defensible and is still wrong in a way that is easy to state: **the highest-paying route for a 5-train may
be the only route a 3-train could have run, and giving it away costs more than it gains. Greedy cannot see
that, because it decides the 5-train's route before it has looked at the 3-train at all.**
**An exhaustive search over a deliberately small space:** at most four trains, each proposing at most a
dozen candidates, with every clashing branch pruned — **thousands of combinations in the worst case,
microseconds, and exact over the candidates considered.**
**It is still not `trace_best_route_set`.** The candidate list is generated per train by a bounded DFS, **so
a route no train proposed cannot be chosen, and the guarantee is "the best combination of the routes we
found" rather than "the best combination that exists". That is the honest claim for a drafting aid.**
**Trains that get nothing are not a failure** — a three-train corporation on a network supporting two routes
should draft two and leave the third empty, **which is what the contract would accept.**

**#8 — the joint search alone is WORSE than greedy on a lot of real boards, and the reason is not obvious
and cost a rewrite to find.** Every train's candidate list is generated against an untouched board, **so
all of them crowd around the same few best rails. Commit the widest train to one of those and the other
lists can be entirely conflicted out.** The sequential algorithm never had that problem: **it REGENERATES
after each commitment, so it discovers the second-best corridor the joint search never put on the table.**
**Measured across 150 board patches: the joint search alone tied on 100 and LOST on 50, once by $240 to
$80. A smarter optimiser that is sometimes three times worse is not an optimiser.**
**So both run**, plus the sequential pass in reverse order (**a narrow train choosing first sometimes leaves
a better remainder**), and the best plan wins. **Running the old algorithm as one candidate makes "never
worse than what we replaced" true by construction rather than by hope.**
**A fill pass finishes the job:** any train left without a route gets one more look at the leftovers.
**Pure upside — it can only add revenue, and it is what lets the joint search's strength combine with the
sequential one's.**

### routeAutoTrace.ts (bounds and termini)
- **The depth cap alone is not enough:** a dense late-game board branches, and an unbounded DFS over it is
  exponential. **The expansion budget makes the worst case a bounded amount of work rather than a frozen
  tab** — reached, it returns the best route found so far, **a suggestion that is merely not optimal rather
  than one that never arrives.**
- **K candidates rather than one**, because the assignment search needs alternatives: **the single best
  route for a 5-train may be the one that strands the 3-train, and there is no way to know that without a
  second option on the table.** Scored by the same pricing function the readout uses, **so 1830's
  pay-a-hex-once rule comes for free rather than being reimplemented as a running total.**
- **A route needs two paying stops** — 1830's two-revenue-centre minimum — **and it has to END somewhere it
  may end. Towns pay, so without the terminus test the best-paying prefix was routinely one that stopped on
  a town, which is not a legal route.**
- **Terminus rails are recomputed rather than copied from the transit set:** a terminus is not a transit, it
  is discovered when the route is recorded. **Without this a route could legally end on a rail another train
  was already using, and the assignment search would hand back a set violating the disjointness it exists to
  enforce. Caught by the sweep across 150 board patches.**
- **Towns count** toward a train's capacity: `City → Town → City` is three stops and a 2-train cannot run it.
  **Verified rather than assumed.**
- **A route runs THROUGH a token far more often than it starts at one**, so each arm is paired with a second
  arm going the other way, joined through the shared city — **and the second arm is barred from the first's
  rails, which is what keeps the joined path a legal single route rather than one that doubles back.**

---

# The Run Routes panel — `components/RoutePlannerPanel.tsx`

### RoutePlannerPanel.tsx #0 — The step was spread across three places
Running a train took four controls and the bar put them in three different regions of itself: the two
buttons that START a route in the far-right utilities rail, the button that FINISHES one in the centre
column **above the route it would submit**, and the readout telling you whether finishing was even possible
in a box below both **that appeared and disappeared.** **A player following the obvious top-to-bottom
reading order encountered the actions in the sequence 3, 1, 2.**
The panel now **is** the sequence: **top** — re-draft if you want to start over; **middle** — see what you
have built; **bottom** — run it, for a stated amount.

### RoutePlannerPanel.tsx #1 → #493 — There was never a manual mode to enter
**#1** diagnosed the pair correctly: "Auto Route" was an **action** and "Manual Route" was a **mode**,
rendered as two identical buttons side by side — **they looked like alternatives and behaved like different
categories, which is why the pair needed two long tooltips to be usable at all.**
**#493 — reported:** remove the separate Manual button; clicking hexes should override the suggestion with
no toggle. **The report is right, and the toggle was already describing a state that did not exist.**
`routeSelectMode` — the flag that actually routes map clicks into the builder — **is forced ON for the WHOLE
Routes sub-phase regardless of which position the toggle showed.** So a player in "Auto-Route" could already
edit the draft, **and `handleRouteHexClick` flipped the label to "Manual" on the first click to stop the
control lying about it.**
**That is a toggle whose two positions did the same thing, kept in step with reality by an assignment buried
in a click handler.** What it cost was legibility: **a player who wanted to edit reasonably assumed they had
to switch modes first, on a screen where they never did.**
**What replaces it is one button, and the distinction is the point.** Auto-Route is an ACTION — "draft this
again" — **with no pressed state to contradict, nothing to leave switched on, and no second position implying
the first one disabled the map.** `RouteBuildMode` is **deleted, not left unused: a mode type with no modes is
how the toggle grows back.**
*(Also see `#7`: while the toggle existed it lifted into the toolbar, because it was the only control in the
panel that does not describe a route — **it picks the tool**, and inside the panel's border it read as a
property OF those routes rather than as the thing that produces them.)*

### RoutePlannerPanel.tsx #2 — The run button carries the number, and its own gate
"Run Selected Route" named the action and withheld the one figure the decision turns on. It reads "Run
Selected Route(s) for $180" now, **which also makes the button the confirmation: the amount on the button is
the amount the route pays, so a player who mis-clicked a hex sees the wrong number before committing rather
than after.**
**Disabled, not hidden, below $1.** Hiding it would remove the only on-screen evidence that finishing is the
next step, **and a player whose route is not yet legal would be looking for a control that no longer exists.**

### RoutePlannerPanel.tsx #3 / #4 — Why the red text is gone, and what stayed
The panel used to stack up to four red strings. **The worst offender was not a warning at all:** "Auto Route
drafted 5 hexes worth $180. Edit it by clicking hexes, or clear it and build your own." **It reported a
SUCCESS in the colour reserved for failure, restated two figures already on screen, and then explained the
panel's own controls in prose. It fired on the happy path, so the steady state of a working Auto Route was a
red paragraph.**
**Nothing in this panel is red unless the player has done something the contract will refuse.**
**#4 — a refused click still has to say so.** `#3` deletes the message Auto Route emitted on SUCCESS; it does
not delete the ones the builder emits when it **refuses** a click. **Dropping these was briefly the state of
this refactor and it was worse than the clutter it removed: a builder that silently ignores half your clicks
reads as broken, and the player's next move is to click harder.** It takes precedence over the standing
blocked reason **because a refusal is about the click just made while the blocked reason is a standing
condition.** Amber, not red: **the route is intact and nothing has failed except one click.**

### RoutePlannerPanel.tsx #5 — A corporation runs every train it owns
**Reported:** the router runs a single train even when the corporation owns three.
The panel modelled one route, and the props said so — **which is a fair model of what a 1830 corporation does
exactly never. It runs ALL of its trains in one Operating Round turn, each on its own route, and the dividend
is the sum.**
**The train list was also deduplicated, which is the deeper half of the bug.** Three 3-trains collapsed into
one chip on the reasoning that "two 3-trains are one CHOICE" — **true when the question is "which train am I
validating this single route against", and false once the question is "which of my trains am I drafting for
now". Three 3-trains are three trains. They need three routes and three chips.**
So the panel takes **drafts, one per owned train, identified by their index into `owned_trains`** — **the only
thing that distinguishes one 3-train from another.**
**The run button sums every VALID route.** A per-train figure would be the wrong number however chosen.
**Invalid drafts contribute nothing rather than blocking the rest** — a player with two good routes and one
broken one can still run the two, **which is also what the contract would let them do.**

### RoutePlannerPanel.tsx #623 — The step's primary action, on the step's toolbar
**Reported:** the sticky bar shows a greyed Auto-Route beside Skip and **no Run button** — "players have to
scroll up to see that."
`#266` moved Run out of the toolbar deliberately, and its reasoning was sound: the button belongs under the
path it runs, and a copy in the bar would be **"the vaguer of the two, since only the panel's copy knows the
figure".**
**What that argument missed is the sticky bar.** The bar follows the player down the page; the panel does not.
**So on the one step whose primary action lives in the panel, scrolling to look at the map takes Run off screen
and leaves a toolbar showing only Auto-Route and Skip — two ways to not finish the step. Every other sub-phase
keeps its finishing action on that bar.**
**The "vaguer of the two" objection is answered rather than ignored:** both buttons read the same
`runnableRouteSummary`. **Neither is the authority; the drafts are, and both render the same derivation.**
That shared summary matters **because `#5` settles a genuinely non-obvious rule** — invalid drafts contribute
nothing rather than blocking the rest — **and the failure mode of a second implementation is a bar button that
offers a total the panel refuses to run.**
**Auto-Route stays.** The report suggests replacing it "since auto-route is the default", **but it is not
automatic: entering the step engages the builder and drafts nothing. Removing it would leave clicking hexes as
the only way to draft a route, which is the opposite of what the request wants.** What it should be is
**subordinate** to Run, which is what putting Run beside it achieves.

### RoutePlannerPanel.tsx #9 / #494 / #499 / #6 — The route table
**#9 — the row's end of the shared cursor.** *Distinct from the active train, and the two are easy to
conflate:* **active** means "map clicks are drafting for this train" — a MODE, chosen by clicking, persisting
until changed. **Highlighted** means "this is the one being looked at right now" — transient, driven by hover,
**and it can point at a train that is not the active one, which is exactly what makes it useful for comparing
two drafted routes.** **Merging them would mean hovering a row silently redirected the map's clicks, which is
the kind of mode change nobody expects from a hover.**
**#494:** the chip wears its own route's ink. **Distinct colours on the map only help if something says WHICH
train each one is**, and this row is where the player is already looking. **An underline rather than a fill:
the chip's active state is a fill, and two colour systems on one control would make "selected" and "this
train's ink" compete.**
**#499 — "RUNNINGROUTE" was not a typo.** *Reported:* the panel is titled "Runningroute", with no space.
**There is no such string, and that is the whole finding.** These are two adjacent COLUMN HEADERS — "Running"
over the train chip, "Route" over the path — **and the first overflowed into the second, so the two words met
on screen with nothing between them.**
**The cause is a width, not a string.** The grid track is 52px, **sized for what the COLUMN holds: a train chip
reading "3" or "5".** The word above it rendered near 68px, **so it ran past its own column and the gap and
straight into its neighbour. Editing the text to "Running Route" would have made the overflow worse and fixed
nothing, because there was never a single label to put a space into.**
**So the header names what the column holds, and fits it. "Train" is both shorter and more accurate** — the
cell under it is a train chip, not a state of running. **"Running" was describing the step rather than the
column, which is what led to a header too wide for the thing it labels.**
`minWidth: 0` and `overflow: hidden` close the **class** of bug rather than this instance: **a grid item's
default `min-width: auto` refuses to shrink below its content, which is why a too-long header silently escapes
its track instead of being clipped.**
**#6 — which full paths are open** is local state: **pure disclosure, and lifting it would make every parent
that renders this own a preference about someone else's detail rows.**
**#474:** the "misses your tokens" refusal is reported **after** the geometric problems and **before** the
generic "worth nothing", **because a route that misses the corporation's tokens is usually a well-formed route
in the wrong place — the player has drawn something valid-looking and needs to be told which rule it misses
rather than that it is worthless.** One sentence rather than one per train: **three broken routes usually have
the same problem, and three copies of it is the clutter `#3` removed in the first place.**

---

# Batch 5C — The waypoint vocabulary and the per-train inks

## utils/routeWaypoints.ts — the manual route-point vocabulary

### routeWaypoints.ts #0 — Why the group travels together
`RoutePoint` is the shape the map hands back when a player clicks a hex; `routePointsToWaypoints` converts a list
into the DTO the contract takes; `axialHexDistance` decides whether two clicked points are adjacent. **One type and
the two functions that read it.** None of it depends on `HexGridRenderer`'s pixel geometry — **only on `{ q, r }`
being a conventional axial pair. That independence is what makes the group safe to lift out on its own.**

`axialHexDistance` is the standard axial hex distance. **The formula depends only on `(q, r)` being a conventional
axial pair (which `pixelToAxial` already produces, `#11`), not on that file's pointy-top pixel
geometry/edge-numbering internals — so this file can validate route-point adjacency without importing anything from
that component beyond the plain `{ q, r }` values `onHexClick` already reports.**

### routeWaypoints.ts — `city_node` on a `RoutePoint`
`undefined` — **the normal case — means "this hex has one stop, or none": a town, plain connector track, or a
single-city tile. Only a genuinely multi-city hex (New York's #62, the OO tiles) needs it, and the map has no
two-city picker yet, so nothing sets it today.** It is carried **on the point rather than bolted on at dispatch
time so that `routePointsToWaypoints` stays a pure rename of fields, and so adding that picker later is a change to
ONE click handler rather than to the payload shape.**

`routePointsToWaypoints` is **the single place the UI's route representation becomes the wire format, so the
deprecated `hex_path: string[]` shape cannot survive anywhere by accident.** `city_node` is **omitted entirely
(rather than sent as `null`) when a point names no station: the field is `Option<usize>` with `#[serde(default)]`-
style optionality on the Rust side, and an absent key is the cleaner encoding of "unspecified".**

### routeWaypoints.ts #474 — A route must CONTAIN a token, not START at one
**REPORTED (critical):** the Run Routes validator requires a route to begin at, or contain, the corporation's HOME
station token.

**The audit found something slightly different from the report and worse: the manual validator checked no token at
all.** `handleRunTrains` filtered drafts on revenue, train distance and terminus **and nothing else — so a player
could draw a run across somebody else's network entirely, price it, and dispatch it for the contract to refuse.**

**Where the HOME hex genuinely was load-bearing is the auto-router** (`assignRouteSet`), which starts its search
from `station_token_hexes`. **That is correct as a search strategy and would be wrong as a rule, and it is easy to
mistake one for the other — the two arms it builds through a token put that token in the MIDDLE of the route, which
is exactly what 1830 requires.**

**THE RULE, stated once so both halves agree: a route is legal if at least one hex on it carries a station token
belonging to the running corporation. Not the first hex. Not the home hex. Any hex, any token.**

**WHY "ANY TOKEN" MATTERS IN PLAY.** A corporation that has placed a second or third token **can run routes nowhere
near where it started — that is most of what the extra tokens are FOR. Requiring the home hex would forbid the
ordinary mid-game run and get more wrong as the game went on, which is the shape of bug that looks fine in testing
and breaks a real session.**

**COMPARED BY COORDINATE, never by label.** `hexLabel` on a `RoutePoint` is a display name ("New York (G19)")
per `boardHexLabel #242`, and `station_token_hexes` is `(q, r)` pairs. **Matching on the human string would work
until the first hex whose name has a place in it.**

The block reason is **phrased for the player rather than as a boolean, because the two failing cases call for
different actions and the difference is not obvious from the board:**

- **NO TOKENS AT ALL** — the corporation has not placed its home station yet, **which since `#416` is a thing the
  president must do deliberately. The route is fine; the corporation is not ready.**
- **TOKENS, BUT NOT ON THIS ROUTE** — the run is somewhere the corporation does not reach. **That is a routing
  mistake, and the fix is to redraw.**

**A route SHORTER THAN TWO HEXES is not judged here at all: it is not yet a route, and `#256`'s own message already
covers it.**

---

## styles/routeLivery.ts — one colour per train

### routeLivery.ts #494 — The colour was the corporation's, not the train's
**REPORTED:** when several routes start at the same city or overlap, they are visually indistinguishable.

**They were identical, and the cause is one line in `App.manualRouteOverlay`:**

```ts
const color = glowColorFor(stationTickerColor(actingProtocolId));
```

**declared ONCE, outside the loop that builds the overlays, and handed to every train. So a corporation running
three trains drew three routes in exactly the same colour — and where they shared a city or a stretch of rail there
was nothing to tell them apart, because there was nothing different about them.**

**`RouteOverlay.color`'s own doc comment has claimed the opposite the whole time:** *"One distinct colour per
train, so overlapping routes stay tellable apart — which is the entire point of drawing more than one."* **That is
the requirement, stated correctly, next to a field that was never given a distinct value.** `#373` then built a
highlight mechanism on top and said the colours *"were always per-train (`#254`), which is what makes the
connection RECOVERABLE"* — **reasoning from a property the data did not have.**

### routeLivery.ts #494a — Why not the corporation's livery
**Losing the corporate colour here costs nothing, and that is worth stating because it looks like a regression.**

**Exactly one corporation operates at a time. Every route on the board during Run Routes belongs to it, so
colouring them all in its livery encodes a fact that is already true of everything on screen — and spends the only
visual channel available on it. The trains are the thing that differs, so the trains are what the colour should
say.**

The corporate association does not disappear: **`StationTokenRow`, the action bar's corporation badge and every
token on the map are all still in livery, and the routes emanate from that corporation's own tokens.**

### routeLivery.ts #494b — Picked for separation, not for prettiness
**Six hues, spread around the wheel rather than sampled from a gradient, so adjacent entries are far apart and not
merely different.** A 1830 corporation holds **at most four trains (four through Phases 2-3, three in Phase 4, two
from Phase 5), so four is the real ceiling and six is headroom — the index wraps rather than running out.**

**ALL SIX ARE LIGHT.** The board is dark and the route line is **a third of the rail's width (`hexCanvasPrimitives
#268`), so a dark hue would vanish into the track ink it is drawn inside.** Same constraint `glowColorFor` was
applied for; **these are chosen above the threshold instead of lifted to it, which keeps the hue rather than
washing it toward white.**

**THEY ARE NOT THE CORPORATION PALETTE, and must not be merged with it.** `corporationLivery.ts` answers "which
company is this"; this answers "which of one company's trains is this". **A shared table would make the two
questions look like one, and the first thing to go would be the separation guarantee — the corporate eight are
chosen for brand fidelity, and three of them are close enough to each other that TD-1's contrast audit had to be
done by hand.**

**THE SIXTH ENTRY WAS ORANGE (`#fb923c`) AND FAILED ITS OWN HARNESS.** It sat **51 units from amber in RGB — under
the 60 the pairwise test demands, and the closest pair in the table by a wide margin. Two warm yellows on a thin
line at low zoom is the exact indistinguishability this palette exists to fix, reintroduced at the far end of it.**

**Lime replaces it because that is where the gap actually was.** Ordering the other five by hue — **amber 43, green
142, azure 199, violet 258, magenta 330 — leaves 99 degrees between amber and green and under 75 everywhere else,
so the sixth hue belongs in the middle of that span. It is a measured slot rather than a colour that looked free.**

The lookup **WRAPS rather than returning a fallback.** A corporation cannot legally hold more trains than the
palette has entries, **so the modulo is unreachable in a real game — but a wrap keeps every route coloured if the
rules ever change or a chain reports an over-limit roster, where a single fallback colour would make two trains
identical again, which is the bug this file exists to fix.** A negative or non-integer index takes entry 0 **rather
than throwing: this is a rendering decision, and no colour at all is worse than the first one.**

### routeLivery.ts #495 — The highlight had both ends and no middle
**REPORTED:** clicking a train chip should highlight only that train's route and dim the others.

**Every piece of that already existed and none of them were joined.** `drawRouteOverlays` has honoured `emphasis`
since `#373` — a 2.2x pen for `primary`, 0.32 alpha for `muted`, a 1.6x glow — **and `highlightedTrainIndex` has
been raised by the planner rows and the train chips for just as long. `App.manualRouteOverlay` built the overlays
between them and never set the field, so hovering a chip lit its own row and the map did not move.**

**A pure function rather than a ternary inside the memo, for the reason `marketMoveDirection` is one: the
interesting case is invisible from the call site. `null` must mean "nothing is highlighted, draw everything
normally" and NOT "highlight nothing, mute everything" — the second dims the entire board whenever the pointer
leaves the panel, which is most of the time.**
