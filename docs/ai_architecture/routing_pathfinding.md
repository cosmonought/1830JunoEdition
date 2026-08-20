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
