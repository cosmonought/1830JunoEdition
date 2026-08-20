# Canvas Rendering — Tile Selector, Veil, Cursors

The radial tile selector, board dimming (the "veil"), cursor modes, tile preview and rotation,
token migration markers, and how a board click is routed to exactly one consumer.

Anchors are `<source file> #<N>`. Search the number.

---

## Board click routing

There are four competing consumers of a hex click, and the props passed to `<HexGridRenderer>`
decide which one gets it. Per `HexGridRenderer.tsx #7` / `#139`, withholding the four interceptor
props (`queryClient`, `contractAddress`, `gameId`, `protocolId`) fully disables the
`GetLegalTilePlacements` click-interceptor, leaving `onHexClick` as the only consumer.

### App.tsx #519 — What disarms the interceptor, and why
| Mode | Note | Effect |
|---|---|---|
| Route select | `#11` | Route-point clicks never also pop the LayTile popup underneath |
| Token targeting | `#159` | Both modes want the click, not the picker — same four props |
| Preview rotate armed | `#162` | A rotation costs no chain round-trip |
| Outside Lay Track | `#199` layer 2 | A stray click costs no query and cannot open a carousel over a board whose click means something else |

**Sandbox forces the offline path (`#24`)** and that is the *mechanism*, not tidiness. A missing
client **or** a missing contract address means "there is no chain to ask", which routes a hex click
into `localCatalogPlacements()` and opens the picker in `offline` mode against the local tile
catalog. Withholding also prevents the alternative, which is worse than useless: `CONTRACT_ADDRESS`
is a non-empty **mock** string and therefore truthy, so without this the interceptor would fire a
real `GetLegalTilePlacements` at a contract that does not exist and every click would surface a
query error instead of a tile picker.

### App.tsx #523 (click precedence) — Home placement takes the click first
A home placement is **modal in intent** — the player accepted a prompt and was sent here to do one
thing — so it takes the click ahead of every other board mode rather than competing with whichever
was left on.

A `private-tile` errand (`#444`) does **not** intercept. The veil has already narrowed the board to
one hex and the click runs the ordinary tile-picker path, so a D&H tile lay is the same pipeline as
every other lay, at the same terrain cost, rather than a second one to keep in step.

---

## The radial tile selector

### App.tsx #163 — Universal planning mode  *[narrowed by #199, resolved by #437]*
Opening the tile selector used to require being the acting president in the Track sub-phase, because
opening it and laying from it were the same gesture. That made the board unreadable exactly when a
player most needs to read it. Inspecting and dispatching were separated; nothing about it loosens a
rule, since a preview is client-side state that touches no message.

### App.tsx #199 — The tile selector is a Lay Track tool, full stop
`#163`'s reasoning was sound and the result was not: a tool that opens on every click, in every
round, and then refuses at the last step **reads as broken**. Worse, it competes for the click
during Tokens and Routes, where the board's click means something else — the player aims at a city
to place a token and gets a tile carousel.

The gate is applied where the ring **opens**, not where it confirms. Three layers, all necessary:

1. A resolved query never opens the ring outside `Track`.
2. The renderer's four interceptor props are withheld outside `Track`, so on a live chain the click
   does not even fire `GetLegalTilePlacements`. Gating only at (1) would leave every stray click
   costing a query round-trip.
3. `<RadialTileSelector>` is not mounted outside `Track`, so a ring already open when the sub-phase
   advances closes with it rather than floating over a board that has moved on. The sub-phase can
   advance without a board click — the stepper's Advance button, a token placed, another player's
   action arriving on a poll.

`canLayTileNow` is deliberately **not** the condition: it also refuses when it is not your turn, and
a player should still be able to browse upgrades on somebody else's Track step.

### App.tsx #437 — Looking is not acting
**Reported:** non-active players cannot select hexes to view the tile selector during an OR.

**One flag was answering two questions.** `tileSelectorArmed` decided both "may this person open the
picker" and, through `layTrackFocus` and the click interceptor, "is this the Lay Track step" — so
narrowing it to the acting player's Track step, correct for the second, closed the picker to
everyone else for the whole round.

The flag splits in two:

- **Inspecting** is available to anyone, in any sub-phase of an OR, spectators included. Reading the
  board is not a move.
- **Acting** keeps every restriction. `canLayTileNow` (`#163`) still gates the ring's confirm
  button and still refuses a spectator, a wrong sub-phase and a wrong turn — so a browsing player
  sees a disabled Lay Track button carrying the reason.

**The cost is real:** `GetLegalTilePlacements` fires on a resolved hex click, and widening the
inspector widens that. Accepted because the query is read-only, cheap, and already fires on every
Track-step click.

### App.tsx #620 — The network filter belongs to whoever may lay
**Reported:** inactive players are restricted to the active player's legal placement options; they
should be able to look anywhere to plan.

Two earlier passes had opened the door and left this shut: `#469` removed the click gate and `#437`
narrowed the veil, but neither touched what the ring **contains** — still narrowed by
`layTrackFocus`, which describes **one** corporation's reach. So a player planning their own next
turn opened the selector successfully and was shown only the orientations that join somebody else's
track. A stranger failure than being refused outright: the tool works and quietly answers a question
they did not ask.

**`canLayTileNow` is the right predicate**, deliberately the same one the confirm button uses. The
narrowing exists because `sandboxTileLegality.ts #6` found the rotate gesture cycling through angles
that looked legal and were not — a real problem, and one that only exists for the player who might
commit. **Sharing the predicate is the point**: a narrowed carousel and a live Lay Track button now
belong to the same player by construction.

**Sandbox/offline path only.** A chain answer is used verbatim (`provisional === false`) because
`GetLegalTilePlacements` is asked about a hex, not about a corporation — the contract already returns
the same list to every viewer.

### App.tsx #162 — Click the preview to rotate it
Rotation belongs on the tile, not in a panel: you are looking at the hex to decide whether the tile
fits, and every pixel of travel to a separate control is travel away from the thing being judged.
60° clockwise per click, wrapping at six — so the gesture is also its own reset. Only fires for a
click on the hex the selector is open on; a click on any other hex is a new selection.

### App.tsx #173 — Rotate through legal angles only
Click-to-rotate stepped `(orientation + 1) % 6` — every angle, legal or not. On an edge hex that
walks the tile's track off the board; on an upgrade it walks through rotations that sever the track
underneath. The player then has to recognise an illegal angle by eye, which is precisely the
judgement the picker is supposed to make for them.

**The legal set is not recomputed here.** `radialCandidates` is already `(tile_id, orientation)`
**pairs** — `filterSandboxPlacements` evaluates path preservation per rotation (`#4` there) and a
chain answer is per-rotation by construction. Sorted, so the cycle runs in a predictable direction.

### App.tsx #622 — A click away is a dismissal, not a selection
**Reported:** with the tile selector open, clicking another hex immediately selects that hex when
the player only meant to close the tool.

The ring's outside-click handler carved the board out: "a click on the board is never a dismissal —
it is either a rotation, a new selection or a new target" (`#168`). True when **nothing** is open.
It stops being true the moment a popover covers part of that board, because the gesture people use
to close a popover is to click somewhere else — and on this screen "somewhere else" is almost always
another hex.

So the board gets the two-stage behaviour every other dismissible surface has: **first click outside
closes, second selects.** `#172` established the principle for water — "clicking open water is the
most natural 'never mind' gesture there is".

**The cost is one extra click** and it is worth paying: opening the wrong ring throws away a
previewed tile and rotation the player may have been part-way through choosing, and fires a
`GetLegalTilePlacements` for a hex nobody asked about.

**A click on the hex already open is a no-op** rather than a re-open — the ring covers most of its
own hex, so this mostly happens on the rim, and reopening would reset `previewTile`.

Read through a **ref**, not a dependency: `handleHexClickQuery`'s identity is load-bearing (the
renderer takes it as an interceptor prop) and rebuilding it every time the ring opens would re-arm
the click path on every selection.

### App.tsx #160 / #172 — Which query statuses open the ring
Both answer shapes feed the same selector — `"success"` carries the contract's verbatim
`placements`, `"offline"` the local catalog mirror, and `provisional` is the only thing that
distinguishes them downstream. `"blocked"` and `"loading"` are **not** openings: the first is a
transient nudge with its own timer, the second has nothing to show yet. `"not-a-hex"` is a
**closing**.

### App.tsx #141 — A blocked cue is a transient nudge
Every other `hexClickQuery` status ends with the player closing the popup, but a blocked click opens
no popup — so there is no close button and nothing would ever clear it. Keyed on the whole state
object rather than on `status`, so clicking a **second** blocked hex restarts the timer instead of
inheriting the first one's remaining time.

### App.tsx #472 — The open hex, derived
The hex whose selector is open, as the renderer's `"q,r"` key, or `undefined` when no ring is up.
Derived from `radialSelector` rather than tracked separately: the ring and the veil must appear and
vanish together, and one nullable object already says whether it is open.

### App.tsx #448 / App.tsx #449 — Token migration markers on candidate thumbnails
While a preview is on the board the canvas belongs to **rotation** — the query interceptor is
disarmed exactly as for route and token modes.

`utils/tokenMigration.ts #0` computes the destination of every token on the hex under the previewed
tile, recomputed as the player cycles tiles because a different tile can carry a different number of
cities. `RadialTileSelector #488b` takes the same migration as **markers**, one
`previewTokenMigration` call per candidate keyed on its own tile id — the destination city depends
on how many cities the candidate carries, so a single shared answer would be wrong for every tile
but one. It is the identical function the caption uses, which stops the picture and the sentence
disagreeing. `stationTickerColor` supplies the fill so a preview token wears the same livery as the
real one (`#428`'s single palette).

`#628`: how many copies of a candidate remain in the tray, read off the **live board** so it moves
as tiles are laid and as upgrades return the tile underneath (`utils/tileSupply.ts` has the argument
for why counting the current map is exact rather than approximate).

---

## The veil (board dimming)

### App.tsx #224 — Only light what this corporation can reach
The board-dimming set for the Lay Track sub-phase; `trackReach #0` covers what it does and does not
claim.

**`undefined` outside Lay Track**, which switches the veil off entirely — no dimming, no click gate,
the board exactly as it was. The renderer treats an absent set that way by construction (`#223`
there), so there is one condition rather than a flag pair that could disagree.

**Also `undefined` when the reach is unknowable.** `layableHexes` reports `unconstrained` for a
corporation with no token on the board — one that has floated but not yet placed its home, or any
state before the first `GetGameState` resolves. Dimming everything then would tell the player they
may build nowhere, which is both wrong and indistinguishable from the feature being broken.

### App.tsx #241 — The corporation's own network stays lit
Choosing where to extend is a judgement about the route the extension joins, and veiling that route
left the legal hexes lit and the reason for preferring one of them in the dark. Unioned in the shell
rather than inside the renderer because this is the layer that has both halves.

### App.tsx #240 — The same veil, for tokens
`#223` built the dimming machinery for Lay Track. Station placement has exactly the same shape — a
small set of legal targets scattered across a hundred hexes — and had none of it, so a player armed
the token cursor and hunted for a reachable city by eye.

Reusing the veil rather than adding a second highlight mechanism means the two steps behave
identically and the refusal a click gets is the same refusal in both. **The set differs, and that is
the whole difference:** track may be laid on hexes the network reaches **or touches**; a token needs
a city with a free, unreserved slot **on** the network.

**Only while targeting is armed** — the veil is a strong visual statement and should appear when the
player has asked to place a token, not for the whole Tokens step, during which they may simply be
reading the board.

### App.tsx #377 — Whose veil is it
The renderer has a board and no identity, so "is the person looking at this the one taking the turn"
can only be answered in the shell. `isMyTurn` is exactly that question and already existed for the
tab-title flash — it compares `viewerAddress` against `actingSeatIndex`, which in an OR resolves to
the **president** of the acting corporation rather than to a seat pointer. That is the right
identity: the veil marks one corporation's reach.

Spread onto whichever focus is live, so token targeting inherits the same asymmetry without a second
flag saying the same thing.

### App.tsx #440 (veil) — The home placement's veil is unconditional
Its `dim` is `true` rather than `isMyTurn`. The other two ask "is the viewer the acting
corporation's president"; this focus only exists because **this** viewer accepted the prompt, so the
question is already answered by its presence. Passing `isMyTurn` here would darken the board for a
president whose corporation floated outside its own operating turn — which is most floats.

### App.tsx #472 (deep veil) — One flag governs all three focuses
`soleFocusKey` is set while a tile selector is open, which veils every other hex deeply — including
the other legal placements. Spread onto whichever focus is live, the same way `dim` is, rather than
each growing its own.

### App.tsx #444 — One veil, three errands
`#440` built the flow for the home station. The D&H's two powers need exactly the same thing — send
the player to the Rail Map, black out every hex but one, arm the right cursor, and put them back
afterwards.

`kind` differs in only two ways: which cursor to arm and what the click does.

| `kind` | Cursor | Click |
|---|---|---|
| `home-station` | station crosshair | free token, the corporation's printed home hex |
| `private-station` | station crosshair | free token, the D&H's F16 |
| `private-tile` | **default** | an ordinary tile lay at the hex's real terrain cost — not intercepted |

That last one is why `kind` is not a boolean "is this a token". A tile lay through this flow is the
normal lay path with the board narrowed to one hex; anything else would be a second tile pipeline.

**Marked on the lay, not on the button press.** A player who opens the map, looks at F16 and
dismisses the picker has not used their D&H.

### App.tsx #269 — Whichever ring is open owns the anchor
The tile picker and the token ring are both anchored to a hex, and the hover tooltip anchors to the
same one. Whichever is open owns that spot; the tooltip stands down. Mounted in the shell rather
than inferred in the renderer because both rings are mounted by the shell.

---

## Cursors and staged placements

### App.tsx #201 — A token is confirmed, not dropped
Clicking a city used to place the token and charge the treasury in one gesture — the only
irreversible, money-spending board action in the app with no confirmation step, where laying a tile
has always asked for a green check.

The click now **stages** a placement: nothing dispatched, nothing charged, the sub-phase does not
advance, and targeting stays armed so clicking a different city re-aims. The green check is the only
thing that commits. The anchor is the hex **centroid** the renderer reports (`#171`), not the
cursor, so the ring sits on the hex however the board is scrolled, panned or zoomed.

### App.tsx #454 — The free placements confirm too
**Reported:** clicking a hex instantly places the token without confirmation.

The ordinary Tokens step has confirmed since `#201`. What placed instantly were the two **free**
placements added later: the home station at float (`#440`) and the D&H's F16 token (`#444`) — both
wrote straight to state on the board click, so the newest flows were missing the oldest safeguard.
They route through the staging state now.

`kind` is what the confirmation then dispatches — a paid `PlaceStationToken`, or a free write that
must **not** go through that message because it charges the escalating token price (`#239`).

### App.tsx #556 — The ring belongs to the corporation placing
**Reported:** placing a home station in a Stock Round shows the right corporation on the cursor and
the wrong one (B&O) on the previewed marker.

`stationCursorCorporation` resolved the company from `homeStationPlacement`; the confirmation ring
read `actingProtocolId`, which is the **Operating Round's** current corporation. In an OR those
coincide — but a home station is placed the instant a corporation floats, and that can happen in a
Stock Round. So the company travels with the staged placement; `null` means "the corporation on
turn".

### App.tsx #514 — The ring wore B&O's blue
**Reported:** the placement preview renders as a blue B&O token whatever corporation is acting.

`actingProtocolId` falls back to `MOCK_LAY_TILE_PROTOCOL_ID` when the operating queue is empty, and
that constant is `4` — B&O. `#433` introduced the fallback so nothing would render `undefined`, a
real concern and the wrong answer here: a station placement always has a corporation, because
`activeStationCompany` is the company whose tokens are being placed.

**Reading the queue for this was asking a question about turn ORDER to answer a question about
IDENTITY.** The two agree during an ordinary OR turn, which is why the wrong colour only appeared
when they came apart.

### App.tsx #496 — Whose token the cursor is carrying
`null` outside a token placement, which keeps the generic disc for every other pointer state.

**The order matches `cursorMode`'s.** A home-station errand (`#440`) names its own corporation and
is modal, so it wins over the acting corporation exactly as it wins the click. Reading
`actingProtocolId` first would put the operating company's livery on a pointer placing somebody
else's home token. A `private-tile` errand is excluded for the same reason it takes the default
cursor (`#444`): it ends in the tile picker, and a token-shaped pointer would promise a placement it
does not perform.

`#440` (cursor): a home placement arms the **same** crosshair the ordinary token step uses — the
gesture being asked for is identical, so the cursor should not differ.

### App.tsx #238 — The three refusals, before anything is signed
This checked only `isTokenableHex` — "does this hex have a city" — so a token could be staged on a
city the corporation's track does not reach, on one whose slots are full, and on another company's
reserved home. All three are refused on chain, but only after a signature, and the error named a
contract variant rather than the situation.

`evaluateStationPlacement` applies the same three rules here and returns the sentence explaining
which one bit. Its `#2` is explicit about what it does **not** claim to judge, so the contract
remains the authority rather than gaining a rival.

### App.tsx #453 — The node travels with the stage
So the confirmation dispatches the city the player actually clicked. **Omitted** when the geometry
could not tell which city was clicked: `sessionKey.ts` documents the absent key as "resolve the
lowest-indexed city with a free slot" — always a legal placement — so omitting is the correct
expression of "I do not know", and sending a guessed `0` would not be.

### App.tsx #159 — "Place Station Token" is a real mode toggle
It used to be a **hint**: it logged a line telling the player to click a hex, and the hex click
opened the tile picker, which lays track and has nothing to do with tokens. There was no way to
place a token from this UI at all. Turning the toggle on now disarms the tile picker and points the
next board click at the token handler.

*(Historical, `#8`: "Place Station Token" has no single-button `ExecuteMsg` of its own — there is no
standalone place-a-station message distinct from `LayTile`, and `LayTile` needs a specific `(q, r)`
the player has clicked.)*

---

## Map grid state

### App.tsx #435 — The board is state, not a memo
Was `useMemo(() => MOCK_MAP_GRID, [])` — immutable by construction, which is why laying a tile in
sandbox appeared to do nothing: the picker confirmed and there was no board to write to. State now,
so `applySandboxLayTile` can replace it with a **new object**. That identity change is what
`HexGridRenderer`'s draw effect watches; mutating the existing `tiles` array in place would leave the
reference untouched and the canvas would never repaint.

### App.tsx #436 — A tile lay is three separate things
Painting the board, charging the corporation, and moving the turn on live in three separate places —
the tile grid is its own query document, the treasury is on game state, and the sub-phase cursor is
App-local. Routing the charge through `runGameplayAction` rather than adjusting the treasury directly
keeps **one dispatch path**: the same `LayTile` message a live game sends, the same log entry, the
same reducer.

### App.tsx #15 — Restored Boston/New York nameplates
**Bug:** "Boston" and "New York" nameplates never drew, even on a freshly loaded board.

The suppression logic — `HexGridRenderer.tsx`'s `hexHasLaidTile(mapGrid, q, r)` — is correct and
purely `mapGrid.tiles`-membership-based. The real bug was upstream: `MOCK_MAP_GRID` pre-seeded all
three landmark hexes with a `tile_id: 10` entry each, reasoning that this was "accurate to the
physical board's own pre-printed track."

That conflated **what is physically pre-printed on a real 1830 board** with **what this codebase's
`MAP_GRID` semantics mean**, which is strictly narrower — confirmed by auditing every `MAP_GRID.save`
call site in `hexmap.rs`, which is called only from inside `execute_lay_tile`. A real freshly created
game's `MAP_GRID` is genuinely empty at all three landmarks until a player's first explicit `LayTile`
there, so pre-seeding was **less** accurate than an empty array and hid the names forever.

**Fix:** `MOCK_MAP_GRID.tiles = []`. Safe, because nothing about a landmark's visual rendering
depended on `mapGrid.tiles` membership: `drawLandmarkTrack` loops `LANDMARK_HEXES` unconditionally
and never consults `mapGrid`, and the static background pass loops `STATIC_BOARD_HEXES` with each
landmark's `printedColor: "Yellow"` baked in.

### App.tsx #36 (station tokens prop) — Structural assignability
`gameState.public_companies` (`PublicCompanyState[]`) is structurally assignable to the narrower
`StationTokenCompany[]` the prop expects — no conversion needed. Omitted entirely while `gameState`
has not resolved, falling back to `HexGridRenderer`'s own stable empty-array default.

### App.tsx #363 — The board's label → `(q, r)` table
Hoisted out of the reducer's context object since `#416`. It was an inline lambda, which was fine
while the float was the only thing that needed it; the home-station prompt needs the **same**
mapping to decide which corporations owe a token and to name the hex it is bound for. **Two copies
of "where is H12" is two answers waiting to disagree**, and the disagreement would be a modal
pointing at the wrong hex.

---
---

# `components/HexGridRenderer.tsx` — The rail map renderer

> **Phase 0 fold.** Notes `#1`–`#130` below were extracted verbatim in an earlier pass into
> `frontend/src/components/HexGridRenderer.design-notes.md` (3,295 lines, uncondensed, inside the
> source tree). That file is now **deleted** and its contents condensed here, so this renderer's
> whole `#1`–`#600+` anchor space lives in one place.
>
> **Known gap, recorded rather than invented:** `#38`, `#39`, `#41` and `#122`–`#130` are
> referenced from source but were never written down — the original numbering jumps from `#36` to
> `#42`. Where a referencing comment states what they were about, that is noted at the reference.

## The board's coordinate system and sourcing

### HexGridRenderer.tsx #1 — Pointy-top axial geometry, reverse-engineered
`hexmap.rs`'s edge indices 0–5 are defined purely by **adjacency** (`HEX_NEIGHBOR_OFFSETS`), not by
any pixel angle — the backend never says which screen direction edge 0 points in. This file derives
that mapping itself: `axialToPixel` is the standard pointy-top conversion, and
**`edgeAngleRad(i) = -60·i` degrees** was reverse-engineered by computing each offset's actual pixel
delta and reading off its angle — **not** the naive `+60·i` a generic hex formula suggests.

Getting this backwards would silently draw every tile's track pointing at the wrong neighbours while
still *looking* like a valid hex grid, which is why it is called out rather than left as an
unexplained sign flip.

Compass: `0=E, 1=NE, 2=NW, 3=W, 4=SW, 5=SE`. Corners sit at `(30 − 60·i)` degrees, so a vertex lands
at true top/bottom and the vertical edges are 0/3 — pointy-top from the start.

### HexGridRenderer.tsx #2 — Client-side catalog mirrors, not queried
`GetMapGrid` returns only each laid tile's `tile_id` + `orientation` — not its bitmask, terrain or
colour — and no query exposes `hexmap::TILE_CATALOG` at all. The TypeScript mirrors are hand-kept.

**Design gap, flagged so it is not mistaken for an oversight:** these drift silently if the backend
catalog changes without a matching frontend edit. The durable fix is a `GetTileCatalog` query or a
codegen step. Until then, **an unknown `tile_id` renders a visible placeholder rather than nothing**,
so drift is loud instead of invisible.

### HexGridRenderer.tsx #6 — The static board is the authentic 93 hexes
Before this, an empty `mapGrid.tiles` — i.e. every game at creation — rendered as bare canvas.
`STATIC_BOARD_HEXES` pre-renders the entire real 93-hex play area at mount.

**Sources, cross-verified rather than guessed:** the Lookout Games 1830 rulebook and
`tobymao/18xx`'s `lib/engine/game/g_1830/map.rb`. Every `label` (`"G19"`) is the board's own printed
coordinate, included so the data can be independently re-checked.

**Coordinate transform** from the physical board's row-letter + column-number labels:
`r = rowLetterIndex (A=0 … K=10)`, `q = (columnNumber − 1 − r) / 2` — always an integer, since column
parity alternates by row.

**Important correction:** an earlier request specified off-board/city coordinates (Canadian Pacific
"B2", Maritime "F2", New York "H12", Boston "K6", Baltimore "G15") that do **not** match the real
board — F2 is Chicago, H12 is Altoona, K6 and B2 are not hexes at all, G15 is a plain mountain. The
verified set is used instead: **New York G19, Boston E23, Baltimore I15**, and seven real off-board
hexes (Chicago F2, Canadian West A9+A11, Gulf I1+J2, Deep South K13, Maritime B24).

**Cross-file consistency: resolved.** The backend's `hexmap::LANDMARK_HEXES` was later updated to
these same coordinates; this file was the source of truth that pass aligned the backend to.

### HexGridRenderer.tsx #6b — Landmark track is pre-printed, and its edges were wrong twice
Real 1830's three home cities are **not** identical and their track is printed on the board, not laid
by a player — so `LANDMARK_TRACKS` hardcodes each city's authentic fixed connections and draws them
unconditionally, while the laid-tile loop skips its generic track renderer at a landmark hex.

**The realignment.** The first version bridged 18xx.games' compass **labels** against this file's own
("their NW is our NW"). That assumption is false for 1830 specifically, which configures its `axes`
differently from the engine's default.

**Caught by an independent sanity check that is now this file's standing method:** computing New
York's six neighbours found that its edges 0/E and 5/SE point at axial coordinates with **no real hex
in `STATIC_BOARD_HEXES`** — impossible for an interior city hex, and a strong signal the translation
was wrong.

Re-verified against real **named** neighbours instead of compass labels: New York's two stubs point
at F20 (New Haven & Hartford, edge 1/NE) and H18 (Philadelphia & Trenton, edge 4/SW) — the real "one
hex, two independent stations" design. Boston connects D24 (edge 1/NE) and F24 (edge 5/SE); it
survived the flawed translation unchanged because `{NE, SE}` is symmetric under the axis flip.
Baltimore connects I17 (edge 0/E) and J14 (edge 4/SW).

**Translation formula:** `our_edge = ((4 − their_edge) % 6 + 6) % 6`.

**Limitation:** only each city's *starting* (Yellow-equivalent) track is modelled; real Green/Brown
city upgrades change printed track further.

### HexGridRenderer.tsx #10 — Off-board pre-printed track
The seven red off-board hexes rendered with no track at all. `OFFBOARD_TRACKS` fixes this, sourced
from the same `map.rb`, translated with `#6b`'s reflection formula — and **re-verified independently**
rather than trusted: every one of the 7 hexes' translated edges was checked against
`HEX_NEIGHBOR_OFFSETS` and confirmed to land on a real `STATIC_BOARD_HEXES` entry, with zero
exceptions. That is strong corroborating evidence the formula generalises beyond the 3 cities it was
derived from.

`drawOffboardTrack` reuses the landmark stub geometry but **omits the station circle** — an off-board
hex is a revenue destination, not a station a train can dwell at.

### HexGridRenderer.tsx #11 — Off-board value plates print both tiers
Real 1830 prints **both** the Yellow and Brown figures on the cardboard up front. Off-board hexes only
ever have two tiers — confirmed from source, not an omission. Purely cosmetic: the contract has no
`ExecuteMsg` for collecting off-board revenue (`OffboardHexNotBuildable`), so nothing here reads live
game state.

### HexGridRenderer.tsx #12 — Gray hexes and OO hexes
`#6`'s own "simplification note" flagged that pre-printed gray hexes collapsed to plain background;
this closes that gap and adds the pre-printed yellow **OO** double-city hexes, which were entirely
unmodelled.

Source verbatim-fetched and **cross-checked byte-for-byte across two independent mirrors**.
`GRAY_HEXES` covers all twelve real gray hexes; `YELLOW_OO_HEXES` the four real OO hexes (Detroit &
Windsor E5, Hamilton & Toronto D10, Dunkirk & Buffalo E11, Philadelphia & Trenton H18).

**`printedColor` composes with `type` rather than replacing it**, specifically so a hex like E5 can be
both a pre-printed yellow city **and** a River hex with its icon and cost label — both are
simultaneously true on the real board.

### HexGridRenderer.tsx #34 / #35 — Blank city hexes and their real values
`cityDesignation` adds eight real 1830 city hexes as white station circles with no printed track.
**Source verification, independently re-derived three times:** all coordinates check out **except two
of the request's own specifics**, which the source does not support and were not applied — B16 is
**Ottawa**, not "Barrington"; F24 is **Mansfield**, not "River Falls".

`#35` adds `HEX_START_VALUE_OVERRIDE`, consulted **before** the flat terrain fallback: New York $40,
Boston $30, Baltimore $30, Montreal $40, Cleveland $30, and **$0** for the four OO hexes and the eight
blank city hexes (their source strings print an explicit `city=revenue:0`). A $0 override **skips the
badge entirely** rather than printing "$0".

**Two factual corrections:** the request labelled F6 "Chicago" — F6 is verified **Cleveland**; Chicago
is the unrelated off-board F2. And its "8 city hubs" list named nine, including F24, which is a Town
hex already correctly at $10.

**Backend scope note:** `hexmap::terrain_base_value` was deliberately left untouched — it is live
payout math applying to every future upgrade, not a "starting" preview figure.

### HexGridRenderer.tsx #36 — Station token markers
The backend tracks tokens in `station_token_hexes` and nothing drew them. Two passes, inserted after
the city-circle passes so tokens layer **on top** of the plain white circle beneath:

1. a **muted** marker at each `STATION_HOME_HEXES` entry whose company has not floated — "reserved,
   not yet active";
2. a **real** marker at every entry in a floated company's own `station_token_hexes`, which naturally
   covers both the free home token and any paid ones with no separate path.

`STATION_HOME_HEXES` is a local mirror of `hexmap::CORPORATION_HOME_HEX`, needed because an unfloated
company has an **empty** `station_token_hexes` — the free home token is only granted at float.

`STATION_TICKER_COLORS` is a deliberately **duplicated** copy of `StockMarketRenderer`'s
`TICKER_COLORS`, for cross-component independence; **if that palette is ever re-tuned, this copy needs
a matching manual update.**

`#36` also redefined `MAX_ZOOM` from an **absolute** cap into a **multiplier on `minZoom`**. The old
absolute `3` could clamp the baseline board-fit back down on a wide viewport, and could even
**invert** — a `minZoom` of 4 with a `MAX_ZOOM` of 3 made the "zoom in" ceiling smaller than the
baseline.

---

## The camera

### HexGridRenderer.tsx #5 / #8 / #13 — Derived fit, clamped pan, locked baseline
**`#5`:** the view pans/zooms once on first mount to frame the whole board; later `mapGrid` updates
redraw in place, because re-fitting on every poll would fight anyone who had navigated manually.

**`#8`:** `minZoom` is **derived**, not hardcoded — exactly the zoom that frames every board hex.
Computed from `hexSize`/`width`/`height` rather than a magic number, so it stays correct if any of
them change. Panning is bounds-clamped by `clampPanToBoard`: **a single reflected min/max formula
handles both cases without branching** — "board bigger than viewport" (keep the viewport inside the
board) and "board smaller than viewport" (keep the board inside the viewport) — because the two raw
candidate bounds swap their ordering exactly where the scaled board size crosses the viewport size, so
sorting them always yields the correct pair.

`boardContentBounds` is memoised on **`hexSize` alone, deliberately not on `mapGrid.tiles`**: the
fittable area is the fixed physical board, not whatever happens to be laid on it.

**`#13`:** the camera is a two-state toggle. The default baseline is a **hard lock** at `fitView`, not
merely a floor — `handlePointerMove`/`handleWheel` are no-ops at baseline. "100%" here means *100% of
the board fits in the viewport*, not a literal `zoom === 1.0`, which would only coincidentally fit any
particular viewport. **The click interceptor still works at baseline** — `dragStateRef` is always
armed so the click-vs-drag distance check keeps functioning; only pan/zoom mutation is gated.

### HexGridRenderer.tsx #43 — A floor below the fit
`minZoom` was also the hard lower bound, so "Fit to Screen" **was** the zoom floor and "−" became a
no-op there. Pulling back past the fit to judge a long route is a normal thing to want. `0.4` lets the
board shrink to roughly a third of the pane width; `ABSOLUTE_MIN_ZOOM_FLOOR` still backstops a
degenerate viewport.

### HexGridRenderer.tsx #19 / #27 — Viewport maximisation, then true proportional scale
**`#19`:** `width`/`height` become optional; the component measures its own wrapper via
`ResizeObserver`. **No separate "auto-scale hex radii" logic was needed** — `minZoom` already computes
`min(width/bounds, height/bounds)`, so a larger measured viewport already yields a larger fit zoom.

**`#27`:** the earlier pass scaled to fill **both** axes, cropping whichever did not match the board's
aspect ratio — which only reads as "maximised" when the hosting pane is a small viewport-clamped box.
Now `height` is **derived** from the board's true aspect ratio at the measured `width`, and `minZoom`
fits `width` alone — since height matches width's implied ratio by construction, **there is no longer
a mismatched viewport to crop against.** The real pixel height cascades up through `App.tsx`'s
un-clamped flex chain so the **browser's** scrollbar carries the rest.

### HexGridRenderer.tsx #30 — Reverted: the board is not a scroll window
This briefly capped height at 72% of the viewport, reasoning that a taller board pushes the action bar
off screen. **The assumption was that a shorter canvas would letterbox.** It does not: the camera
holds a locked baseline pose (`#8`), so a shorter canvas simply **shows less of the board** — cropped
top and bottom, reachable only by panning inside a scroll window nested in a scrolling page.

If the chrome being pushed down is worth solving later, the fix is a **smaller board** — fewer pixels
per hex — not a smaller window onto the same board.

### HexGridRenderer.tsx #34 (tab guard) / tab-switch shrink
The `ResizeObserver` zero-size guard was `< 1`, which only caught a literal zero. Switching tabs away
and back can report a transient **single-digit** pixel `contentRect` mid-swap, sailing past that gate
and collapsing `measuredSize` and the whole camera fit. Widened to `<= 10`; simply `return`ing without
calling `setMeasuredSize` already **is** "preserve last known valid settings".

A second, related bug: the auto-fit was a **one-shot** effect with empty deps. `App.tsx` fully
unmounts and remounts this component on every tab switch, so "on mount" happens on every return trip —
and on the first render after each mount `width` is still the small `DEFAULT_WIDTH` fallback, because
the `ResizeObserver` fires asynchronously. The effect captured a `fitView` from the too-small width and
never ran again. Fixed by re-running on every `fitView` change, gated on `!detailedView` — which is
also just `#13`'s own stated invariant, now actually enforced continuously.

### HexGridRenderer.tsx #67 — Scroll-wheel zoom removed
The manual buttons should be the only way to zoom. The zoom math is **removed entirely**, not merely
gated, so there is no dead path to accidentally re-enable. `handleWheel` now only calls
`preventDefault()` — a scroll-**containment** concern (stop the page scrolling under the cursor),
separate from zoom.

---

## Margin labels: five passes and a reversal

### HexGridRenderer.tsx #16 — Row letters and column numbers
`drawBoardMarginLabels` stamps the board's own row letters (A–K) and **its real printed column
numbers**, parsed off each hex's `label` — not an invented 1/2/3 sequence.
`computeBoardMarginLabels` derives each position purely from `axialToPixel`, exploiting the property
that makes a real board's rows and columns print as straight lines: **a fixed axial row shares one
pixel `y` regardless of `q`, and a fixed real column shares one pixel `x` regardless of which row
supplies it.** Straightened to one shared line per side (min/max across the **whole** board, not
per-row), because the board's ragged ends would otherwise staircase the gutter.

### HexGridRenderer.tsx #20 / #23 / #24 / #25 — The DOM detour, and its reversal
`#20` moved the labels to a `position: absolute` DOM overlay pinned to the locked `fitView` transform.
`#23` added a projected frame rect; `#24` replaced it with a `w-fit h-fit` wrapper and pinned labels to
the canvas's literal pixel edges.

**`#24`'s key insight, worth keeping:** the `<canvas>` element already renders at exactly
`width × height` — `#19`'s "empty space" is pixels drawn *inside* the canvas by zoom-to-fit, not space
around the element — so `w-fit h-fit` and viewport-fill are **not** in tension. The real hazard was
**circularity**: making the `ResizeObserver` target itself `w-fit` would make its size depend on its
canvas child, whose size depends on measuring it. Solved with a second inner wrapper.

**`#25` reverses the whole detour.** Drawing the labels inside `draw()`'s own
`translate(pan)/scale(zoom)` world-space transform — the same one every hex and track already uses —
**eliminates the problem's premise**: alignment with the live view falls out automatically, with no DOM
position, no projection, no `ResizeObserver` circularity and no frame element left to reason about.
Not because `#20`–`#24` were wrong on their own terms; each correctly solved the DOM-positioning
problem it was given.

### HexGridRenderer.tsx #28 / #31 — Measure the label, not just the anchor
`#26`'s tight `hexSize`-only camera padding cleared the outermost hex's **silhouette** and never
accounted for a drawn label's own rendered box extending further still. `computeBoardMarginLabels` now
takes the live `ctx` and measures the actual widest row-letter and column-number label with the exact
font `drawBoardMarginLabels` sets — a real rendered size, not a guessed constant — and folds that
half-extent plus the background padding into an inward safety offset.

`#31` tightened one real imprecision: the function now takes the actual **floored** `fontSize`
(`max(11, hexSize * 0.3)`) rather than re-deriving an un-floored `hexSize * 0.3`, which at small hex
sizes understated the label's rendered size by exactly the floor.

**Width vs height are not interchangeable.** Row letters sit left/right, so what determines clearance
is their **width**; column numbers sit above/below, so what matters is their **height**. The previous
version measured `.width` for both and reused one value, which happened to work for row letters and
understated column numbers — letting the top/bottom row sit on the outermost hexes.
`actualBoundingBoxAscent`/`Descent` supply the vertical analogue, falling back to `fontSize` where a
backend does not populate them.

### HexGridRenderer.tsx #33 — Transparent margin fills
Re-verified rather than taken at face value: the labels drew through the same
`drawLabelWithBackground` convention as every other label, whose default background is a translucent
**white** box — so the report's "solid black" description did not match the source. The underlying
complaint is real: **the margin band sits over one uniform charcoal fill, where a contrast box was
never earning its keep.** `background: false` skips it.

**Consequence caught and fixed:** the text colour `#1a2e1f` (dark green) was only ever legible against
that box. Against `#141414` charcoal it has effectively no contrast at all — left unchanged, this
would have made the labels **invisible** rather than "floating cleanly". Switched to `#f0f0f0`.

---

## Layer order and the draw pass

### HexGridRenderer.tsx #55 — Strict canvas layering hierarchy
Fill → terrain icons → track splines → station badges → name labels. The one out-of-order pass — the
terrain build-cost label, drawn as pass #2, i.e. Layer 4 text before any Layer 2/3 content — is split
from its Layer 1 icon and moved down beside the other badges.

### HexGridRenderer.tsx #222 — Tokens are drawn last, not merely late
**Reported:** badges render on top of and obscure tracks and cities.

The token pass ran immediately after the city circles, on the reasoning "layered on TOP of every
station circle drawn above". True of the circles, **false of everything that came after** — the value
badges, restriction badges and every nameplate pass all draw further down, so all of them landed on
top of the tokens.

**A badge covering a token is worse than a badge covering track:** a token is the one marker that says
whose network this is, and a route's legality turns on it. The value badge sitting over it is
information the player can get from the tooltip; the token is not.

Deferred as a closure rather than physically relocated, because it reads `claimedHexSlots` and the
company map built alongside the passes above.

### HexGridRenderer.tsx #588 — The veil was painting over the tokens
**Reported:** during a Place Home Station action the reservation markers disappear.

They were drawn and then **buried**: the token pass ran before the focus veil, so the veil's fill
landed on top of every token. A reservation badge is already at 0.45 alpha by design (`#116`); under
the deep focus veil the product of the two is effectively nothing.

So the pass moved after the veil — **which is what `#222` was already arguing for and stopped one pass
short of.** A veil is a badge over the whole hex. The veil still pushes back track, cities and labels;
what it no longer does is hide the piece the player is being asked to reason about.

### HexGridRenderer.tsx #150 — A laid tile covers the preprint
On the physical board a tile is cardboard placed **on top** of the printed hex; the artwork underneath
is not visible through it. This renderer drew both. The `isComplexHex` test already skipped most tiled
hexes **as a side effect** — it asks "is this visually busy", not "is it covered" — so the explicit
check states the actual rule and covers the case the incidental one missed.

Same fix applied to the OO station circles ("always drawn" was written when nothing could be laid on
those four hexes; once green #59 and the brown OO tiles could be, an upgraded Philadelphia & Trenton
rendered **four** station circles) and to the blank city/town marker passes (two stacked circles read
as a *rendering imprecision* rather than as an obvious bug, which is worse).

### HexGridRenderer.tsx #133 — Laid tiles win over pre-printed landmark artwork
**Reported:** tile #62 draws crossing track with a station dumped on the intersection.

The `!landmarkAt(...)` guard meant a laid tile on New York/Boston/Baltimore never called
`drawTrackPath` **at all** — so #54/#62 and #53/#61 could never reach the hardcoded artwork catalog.
What the player saw was the **pre-printed** landmark track, whose two stubs run to a fixed NE/SW
diagonal: one stub crosses the other and the station sits on the crossing. Entirely upstream of the
#62 path strings, which are provably non-crossing.

**The pre-printed pass is now the one that yields**, which is the correct direction: printed artwork is
what a hex shows *until* a tile covers it.

### HexGridRenderer.tsx #288 — The landmark hubs upgrade like anything else
**Reported:** G19's green upgrade has no revenue badge.

`NewYorkHub`/`BostonHub` were excluded from the laid-tile badge pass on the reasoning that "both
terrains only ever occur at a landmark hex, which the landmark badge pass always catches first". True
when written and **false one design note later** — `#133` made the landmark pass yield as soon as a
tile is laid, precisely so the tile could draw its own badge.

Which left the two hub terrains falling **between** the passes: the landmark pass stood aside for the
tile, and the tile pass did not accept the terrain. `drawValueBadge`'s parameter is widened rather than
the terrains being mapped onto a lookalike — **a `NewYorkHub` is not a `DoubleCityHub`**, and pretending
otherwise to satisfy a type would be the kind of near-enough this file's notes keep unpicking.

---

## The veil and the glow

### HexGridRenderer.tsx #223 — The wild blue yonder
**Reported:** players can click anywhere to lay track.

They could. The click path's only board-level gate was `evaluateHexForTileLaying`, which answers a
**static** question — is this a real hex, and the kind a tile may ever go on — and knows nothing about
the corporation doing the laying.

When `layFocus` is supplied the board renders 18xx.games-style: reachable hexes keep their brightness
and take a highlight, everything else is veiled, and a click outside the set is reported `"blocked"`
with a reason rather than opening a picker the contract would refuse.

**Keyed `"q,r"`, a `Set` not an array**, because the draw loop tests every hex every frame and a linear
scan per hex is quadratic on a 100-hex map. **Omitted means no dimming and no gate** — which is what
every phase other than Lay Track passes, and what Lay Track itself passes when the reach cannot be
determined: a board dimmed on a guess would take the map away over missing data.

### HexGridRenderer.tsx #241 — Three tiers, not two
A single set of legal hexes produced two reports, both about the same missing tier:

- **The network vanished.** A player choosing where to extend reasons about the route the extension
  joins — and that route was in the dark, because it is not itself a legal target. `visible` keeps the
  corporation's own track lit alongside the placements.
- **The highlight was a border.** A crisp green ring reads as UI chrome stamped over the cardboard.
  `highlighted` is drawn as a soft bloom so it reads as the board glowing rather than a box drawn on
  it.

**`highlighted` must be a subset of `visible`** — a hex that is legal but dimmed would be the worst of
both. The caller unions them, since the caller holds both sets.

### HexGridRenderer.tsx #367 → #377 — The veil deleted, then restored asymmetrically
`#367` removed the veil outright on two objections. **Only one survives, and it needed a condition
rather than a deletion:**

- **Right:** it dimmed the board for **everyone**. `layFocus` describes one corporation's reach and
  every player sees the same canvas, so three of four watched the map grey out for a restriction that
  was not theirs.
- **Overstated:** "it suppressed the board to emphasise a subset." True at `0.55`, where more than half
  the light went. The active player genuinely does want contrast against their own legal set, and the
  answer is a **lighter overlay**, not none.

`#377` restores it gated on `dim`, set by the shell from `isMyTurn` — **only the shell knows who is
watching; the renderer has a board and no identity.** Default `false`, so a caller that has not thought
about whose turn it is gets the undimmed board.

**The click gate was never the veil's job** — `layFocus.highlighted` decides which hexes open the
picker, so the original bug stays fixed either way.

### HexGridRenderer.tsx #252 — An outer glow, not a ring with a shadow
**Reported:** the legal-placement highlight is a thick solid green border with no glow.

Two causes, and the second is the one that mattered:

- **The line was too heavy.** `hexSize * 0.13` is wider than the track artwork itself (`0.12`), so
  whatever the alpha, the eye read it as a drawn border. Now `hexSize * 0.02`, floored at one pixel.
- **The shadow bloomed both ways.** `ctx.shadowBlur` spreads symmetrically, so **half of every "glow"
  was painted inside the hex, over the cardboard.** Inward bloom on a hex-sized ring fills the hex —
  which is exactly what turns a glow into a solid tint.

**A true outer glow needs the inside masked.** The clip is a generous rect **minus** this hex, built as
one path and clipped `evenodd`; stroking the hex through it discards everything inward and leaves only
the halo escaping. That is what a glow is — light spilling out of a shape, not a ring drawn around it.

The colour is the acting corporation's, matching the toolbar and the route line, with a fallback for a
brand colour too dark to register as light — **a glow that cannot be seen is not a glow.**

### HexGridRenderer.tsx #420 → #472 — Three alpha values, each a reaction to the last
**`#420`:** `0.22` was a dimming nobody could see. The mechanism was never missing; the **effect** was,
and the reason is arithmetic rather than logic: `#070b14` is near-black, the unlit board is already
very dark, and 22% of near-black over near-black is a few RGB points. **That is how a working feature
comes to be reported as absent.** Moved to `0.42`, chosen between `0.55` (judged to suppress the board)
and `0.22` (over-corrected past visibility). The test both endpoints failed: a veiled hex must still
read as **cardboard** while being unmistakably behind the lit set at a glance.

**`#472`:** base takes `0.42` up ~30% to `0.55`, and adds a **second, harder veil** — its own constant
rather than a multiplier, because it is a different statement:

| Veil | Question | Alpha |
|---|---|---|
| Base | "where **may** I build" — a survey; every legal hex must stay comparable | 0.55 |
| Focus | "what am I deciding **right now**" — a ring is open over one hex; the other legal placements have stopped being options this second | 0.82 |

**Deliberately not opaque even at 0.82:** the board must stay visible enough to judge a tile against its
neighbours, which is the whole reason the player opened this hex.

`soleFocusKey` is a **key, not a set**, deliberately — exactly one radial menu can be open, so a set
would permit a state the app cannot reach and the first reader would wonder what two focused hexes look
like.

### HexGridRenderer.tsx #178 (fall-through) — Dimmed **or** glowed was itself a bug
`#367` deleted the veil and with it an early-exit that meant a hex could be dimmed **or** glowed, never
both. A legal target is always inside `visible`, so the two never actually collided — **but the
structure said they might**, and falling through means the glow is reached on every hex regardless.

### HexGridRenderer.tsx #463 — The node, not just the hex
**Reported:** valid city markers do not glow, so which node to click is not obvious.

The hex-level glow marks **where**, and on a one-city hex that is the whole answer. On a two-city hex it
is not: the player is told this hex and then has to guess which of two printed circles the click means.

`cityNodePoints` is the **same geometry `cityIndexAtPoint` resolves a click against**, which is what
makes the glow a promise rather than a decoration — **a marker cannot pulse somewhere a click would not
land.**

Only while `cursorMode === "token"`. `#463` also added the repaint loop: this canvas has never had an
animation loop, and a pulsing glow needs frames — so the loop **exists and is gated**, running only
while a placement is armed. `prefers-reduced-motion` **stops it entirely** rather than shortening it: a
ring at its steady mid-swell says "these nodes" perfectly well without moving, and honouring the
preference by animating more gently would be missing its point. A 1.6s cycle — **slow enough to read as
breathing rather than blinking, which is the difference between a hint and an alarm.**

### HexGridRenderer.tsx #515 — The ring frames the slot, not the hex
**Reported:** the pulse has too large an orbit and radiates outward rather than marking the node.

Every term was a fraction of `hexSize`, **which is the wrong unit for a mark on a city slot.** On a
plain hex the token is `hexSize * 0.22`; on a laid multi-city tile it docks at `tileCityTokenRadius`,
roughly half that — so the same ring drew a halo at **twice the radius of the thing it was pointing
at**, on precisely the tiles where saying *which* node is the whole job. The radius now comes from the
token that will land there.

### HexGridRenderer.tsx #585 — Slot rings are for home stations only
**Instructed:** restrict the token glow to home station placements.

A home station is **one hex with one or two nodes** — a bounded problem, and the moment a new player has
least idea what is being asked. A built-up corporation's Tokens step is the opposite: many legal tiles,
each a fresh chance for the geometry to be wrong (**it has been wrong three times: `#515`, `#557`,
`#580`**), and by then the player placing their fourth token does not need the hint. **One slot, not all
of them** — resolved by asking `stationMarkerPoint` (`#584`) rather than a second table of home cities.

---

## The click interceptor

### HexGridRenderer.tsx #7 — Three places by design, not by accident
(a) This file owns pixel→axial conversion **and** firing `GetLegalTilePlacements` itself, via the
optional structurally-typed `queryClient` prop — so it never imports `@cosmjs/*` and stays usable with
zero wallet dependency when the props are omitted. (b) The floating card and all wiring live outside
this file, consistent with the "renderer is presentational, `App.tsx` owns wallet/session" split.
(c) The live preview is one `previewTile` prop plus one draw pass.

**Orientation is a real, binding choice.** `ExecuteMsg::LayTile` takes a required `orientation` and
`execute_lay_tile` commits **exactly** that rotation, rejecting the call if that specific angle is not
legal — it no longer auto-picks the lowest legal one. A prior contract had no `orientation` input at
all, which silently removed a genuine 1830 strategic decision.

Pointer-**up** is used rather than a native `click` so a genuine click can be told from the tail of a
pan drag using the **same** `dragStateRef` already tracked for panning, rather than a second parallel
gesture tracker.

### HexGridRenderer.tsx #141 — The four static board gates
Four hard gates before the picker may open. **Split deliberately either side of `onHexClick`**,
because the two halves answer different questions and only one is about laying a tile.

**Gate 1 runs first**, before `onHexClick`: "this coordinate is not a hex" is not a tile-laying rule,
it is the **absence of a target**. `pixelToAxial` maps every point in the canvas to *some* axial
coordinate — including the wide empty margins and the real gaps inside the non-convex outline (row A
has no A13/A15) — so without this, clicking blank background is indistinguishable from clicking a
hex, and route-point selection would happily append a point in the middle of the Atlantic.

**Gates 2 and 3 run after** `onHexClick` and after the route-select bail-out, both on purpose:
off-board and gray hexes are perfectly legal things for a **route** to run through — that is what they
are for. "No tile may be laid here" is a different claim from "nothing may happen here".

**Why a client-side gate at all**, given the standing rule that this frontend does not re-implement
contract legality: **these four are categorically different.** Connectivity, tray depletion, upgrade
topology and era locks are **stateful** — any client-side answer is a guess that goes stale. These
four are **static board geometry plus one colour comparison**, none of which can change during a game.

**The conservatism rule, which matters more than the gates themselves:** this must only ever block
what is *definitely* illegal. **A false block is strictly worse than a false allow** — a false allow
costs a rejected transaction and an error message; a false block makes a legal move look impossible
and is invisible, unreportable, and indistinguishable from the feature working.

`gateHasNextTier` deliberately checks **colour only, not terrain compatibility** — the contract's
upgrade rule tests the colour step and edge-superset topology and does **not** require terrain to
match, so filtering by terrain would block upgrades the contract would accept: precisely the false
block the rule forbids.

### HexGridRenderer.tsx #120 / #139 — The picker's offline path
**Reported:** the tile picker refuses to open at all with no backend — no exception, and the "hex
clicked" log still printing.

**Not caused by the pass that preceded it**, despite arriving right after. The real cause was
long-standing and structural: the click guard tested all four interceptor props at once, and those
props go missing for **two unrelated reasons**. Route-select mode omits them **on purpose**, so a
route-point click does not also pop the picker. Running without a wallet or node leaves **only**
`queryClient` undefined. Both hit the same `return`, so `onHexClickQuery` never fired and the popup
never rendered. **The picker had no offline path whatsoever — it wasn't hanging or failing, it had
decided there was nothing to do.**

Split on that exact distinction: missing hex identity (`gameId`/`protocolId`) still returns silently;
missing `queryClient` falls back to `localCatalogPlacements` and reports `status: "offline"`.

**`#139` is the other half.** `!contractAddress` used to sit in the *deliberately-off* test and
**survived only because it was never falsy** — the address was a hardcoded placeholder that was
invalid but **truthy**. Offline mode was, without anyone intending it, **load-bearing on a fake
constant being truthy.** Once F-4 moved the address into the environment where an unset variable is
correctly `undefined`, that guard began swallowing every hex click in exactly the sandbox mode that
has no address by design. It now sits beside `!queryClient`, because the two mean the same thing.

**A distinct status, not a flag on `"success"`:** a separate variant makes the type checker point at
every consumer that must decide what to do with unvalidated data, where a flag lets a consumer treat
it as authoritative just by not knowing to look. `localCatalogPlacements` filters by **era and nothing
else** — no connectivity, no reservations, no colour step, no tray depletion.

### HexGridRenderer.tsx #171 / #506 / #516 — Anchor to the hex, not the cursor
**`#171`:** callers were anchoring UI to `clientX`/`clientY`. A radial menu built on that opens
wherever the pointer landed, so clicking near a hex's rim produced a ring visibly off its own hex, and
two clicks on the same hex produced two different rings. **Anchoring wants the hex, and the hex's
centre is a property of the grid, not of the click.** Projected through the same transform `draw()`
applies, so it tracks pan and zoom for free.

**`#506`:** the hex's **on-screen radius** is reported alongside the centre and for the same reason —
`hexSize` is the board's unit and says nothing about how big the hex actually looks; a clearance
computed from the unscaled constant is wrong by exactly the zoom factor. Deliberately **not** reported
on `onHexClick`: none of that callback's consumers position a surface that must clear the hex.

**`#516`:** the centroid is right for a **tile** picker (that ring surrounds the whole hex, because the
whole hex is being replaced) and wrong for a **station** confirmation, which is about one slot.
`nodeX`/`nodeY` fall back to the centroid rather than being nullable — **a hex with no resolvable city
node has exactly one sensible anchor**, and making the caller handle `null` would push out a decision
with only one correct answer.

### HexGridRenderer.tsx #453 / #557 — Which city, not just which hex
**`#453`:** `PlaceStationToken` carries an optional `city_index` and every caller omitted it, so the
contract fell back to "lowest-indexed city with a free slot" — always legal, and on a double-city hex
a coin toss against what the player clicked. **`null` means "could not tell", not "city zero"**, which
is the whole reason it is nullable: on an untiled preprinted double city there is no per-city geometry
to hit-test, so the honest answer is nothing, and omitting the field lets the contract apply its
documented fallback rather than sending a guessed index with full confidence.

**`#557`:** on a **single**-city hex the centroid fallback is wrong, because nothing was ambiguous —
there is only one city and the player is about to place a token in it whatever part of the hex they
clicked. **The anchor only.** `cityIndex` still travels as `null`, because it answers a different
question — "was this a click **on** a city" — which other board modes use to choose between opening the
picker and targeting a slot.

### HexGridRenderer.tsx #172 — Say so, rather than returning silently
Returning with no signal was right when the only consumer was the picker; there is nothing to open over
open water. It stopped being right once something could already be **open**: a ring stayed up while the
player clicked around the ocean trying to dismiss it, because **the one gesture that obviously means
"never mind" produced no event.** `"not-a-hex"` carries no placements and opens nothing; its entire job
is to let a listener close what it opened.

### HexGridRenderer.tsx #257 → #469 — A dimmed hex says it already, and looking is never gated
**`#257`:** the `"blocked"` explainer was right when the board gave no other signal. **The veil changed
the premise** — the clicked hex is visibly dimmed and the legal ones visibly glowing, so the explainer
restates in words what the board already said in light, as a popup following the cursor, on the one
step where a player is most likely to be clicking around deciding. The status is still **superseded**
(`clickQuerySeqRef`) so a late response cannot open a picker over the hex just refused: **silence must
not mean "and also let the last thing through".**

**`#469` removes the gate entirely.** Both `#257` and `#437` were answering "how do we refuse this click
without a popup" — and **the honest answer is that opening a picker is not a click that needs
refusing. It shows candidate tiles. It commits nothing.** Execution is untouched and was never here:
`canLayTileNow` gates the confirm button with the reason **on** it, which is strictly better feedback
than the silence it replaces.

`layFocus` was consequently **dropped from this callback's dependencies** — there is no gate any more,
and the veil that still reads it lives in `draw`, which has its own dependency. Keeping it would
re-create the callback on every reach change for no behaviour that reads it.

---

## Tooltips

### HexGridRenderer.tsx #21 / #26 / #29 — The hover card
`#21` resolves the hovered `(q, r)` to a board label and renders a `position: fixed` DOM tooltip;
`#26` enriches it with `(Value: $X)`.

**`#29`:** this was the worst offender on the board and for a specific reason — it drew at
`FONT_SIZE.heading`, the **section-heading step**, with `whiteSpace: nowrap` and no maximum width. A
hover over New York produced a single unbroken heading-sized line carrying the name, value, terrain
cost and every station, growing until the sentence ended: on a 1080p screen, a band most of the way
across the map.

**A tooltip is annotation.** It sits over the thing it describes and should be **the smallest readable
thing on screen, not the largest** — so it takes the `small` step, a hard 280px ceiling, and wraps.
`nowrap` went with the cap necessarily: **a cap on a line that cannot break is a cap that does
nothing.**

### HexGridRenderer.tsx #365 / #383 — The tooltip waits
**Reported:** map tooltips appear instantly, causing visual fatigue while scanning.

The cost compounds with the board's density: dragging across the map fired a tooltip on every hex
crossed. **An instant tooltip is right for a control whose meaning is unclear; it is wrong for a
hundred adjacent things you are looking *past* on your way somewhere.**

**What is not delayed:** `hoveredHexCoord`, the highlight under the cursor. That is **feedback** — it
tells the player what they are pointing at — and delaying it would make the map feel unresponsive. Only
the text panel waits.

**The timer is restarted, not merely started,** on every move onto a new hex, which is what makes the
delay per-hex rather than per-entry. `#383` cut 2000ms → 1200ms: the delay exists so a sweep does not
trail a queue of tooltips, and 1200ms still clears that bar, while 2000ms additionally cost the case
the delay is **for** — a player who stops intending to read waited long enough to wonder whether
anything was coming.

Everything the panel needs is **captured now and shown later**: reading `event` inside the timeout
would be a use after React has pooled it, and re-deriving the hex would risk describing whatever is
under the pointer two seconds later.

### HexGridRenderer.tsx #269 / #505 — Three tooltip states, not two
**`#269`:** clicking a hex opened the selector **and** left the tooltip on top of it. Both are anchored
to the same hex, so they do not merely overlap by accident. The tooltip is also the less useful of the
two by a distance: it names a hex the player has just deliberately clicked. **The renderer cannot work
this out for itself** — the tooltip is hover state and the picker is a modal surface mounted by
`App.tsx`, so the owner of the modal is the only one who knows it is open. Two guards: refuse to set a
new one, and clear the one already showing.

**`#505` — the third state.** `#269` reasoned about the tooltip as either **already showing** or
**about to be set by a mouse move**. There is a state between them: **armed but not yet fired.** With
`#365`'s dwell, a hover schedules the timer and returns; click at 1.9s and the ring opens, the effect
clears a label that is still `null`, and 100ms later the timer fires **on top of the open ring**.

**It survived `#269` because it is timing-dependent and both natural ways to test it pass** — click
after the tooltip appears and the clear works; click before the dwell and nothing was armed. Only the
narrow window reproduces it, **and the window is exactly as wide as a player's hesitation before
committing to a hex** — which is to say, the most common way this hex gets clicked.

`cancelTooltipTimer()` closes it at the cause; a render gate is the belt to that braces, making "no
tooltip while a picker owns the hex" a property of what is **drawn** rather than of three state
transitions all being handled.

### HexGridRenderer.tsx #75 — Adaptive quadrant
The DOM tooltip always anchored down-right of the cursor, so it ran past the panel edge for any hex near
the right or bottom side. `preferLeft`/`preferAbove` are computed from the cursor's position within the
**canvas's own bounding rect** — not the browser window's — so the flip threshold tracks the panel's
actual edges even when the canvas does not fill the viewport. (Mirrors `drawOffboardTooltip`'s own
adaptive quadrant, which flips toward whichever side points back at the board's interior — deliberately
**not** a blanket "always below-left", which would just move the clipping to the other edge.)

### HexGridRenderer.tsx #103 / #117 / #118 / #287 — What the tooltip says
**`#103`:** the `(Value: $X)` suffix is suppressed at `X === 0`, reversing `#35`/`#37`'s deliberate
literal "(Value: $0)". `hexRouteValue`'s return is untouched — only the formatting layer changed. A
`(Terrain Cost: $Y)` suffix is added, re-adding the `$` that `#94` dropped for the badge, because this
is a text sentence rather than a box.

**`#287`:** **it is a price, so it stops being news once paid.** A river or mountain fee is charged
**once**, by the lay that crosses it — so on a hex that already carries a tile the figure is not a cost
the player faces, it is a receipt for one somebody already settled, sitting in the same parenthesis as
the live route value where it reads as money still owed.

**`#117` → `#118`:** `(Stations: N)` was a **capacity** count from `archetypeForHex`. The request was
never a count — it was *which corporations actually have a token here*, printed by ticker. Reworked to
cross-reference `publicCompanies` against `(q, r)`. Singular `(Station: X)` for one, plural for more,
**omitted entirely** when none — the same "only appears when true" standard `#103` applied.

**The tooltip carries the full company name for a single token** because the canvas token can only fit
an acronym and **a canvas token has no DOM node to hang a `title` on** — this hover string is the only
place a player can find out which railroad that acronym is. Multiple tokens stay as bare tickers: three
expanded names would run past the tooltip's edge.

### HexGridRenderer.tsx #47 / #364 / #366 — The reservation badge and its tooltip line
The badge says a hex is spoken for; it has no room to say **by whom** in words. The tooltip is where
that gets spelled out, and `#365` made it something a player deliberately waits for rather than
something that flashes past — **so a line appended here is a line somebody asked for.** One short
clause, **appended rather than substituted**: the hex's own description is why the player hovered; the
reservation is a qualifier on it.

---

## Route overlays and hover

### HexGridRenderer.tsx #137 — Traced train routes
The layer the board previously had no equivalent of: track was drawn, but **which** track a train
actually ran was never shown, so a player building a manual route had no visual confirmation.

**Position in the pass order is deliberate and is the whole reason it sits where it does:** *after*
every track pass, so a route reads as running **on** the rails rather than under them; *before* station
tokens, city circles and every badge, so the overlay can never bury the markers a player needs to read
the board. **A route is an annotation over the map, not a replacement for it.**

### HexGridRenderer.tsx #155 / #195 — Hand the overlay the real rails
`#155` passes a plain lookup closure rather than the whole grid — **the primitive has no business
knowing what a `MapGridResponse` is.**

**`#195` is the one that fixes preprinted track.** `tilesAt` can only answer for a hex carrying a laid
`MapTileEntry`; **every gray hex, all three landmarks and every off-board terminal have real rails and
no tile record**, so the overlay had nothing to follow and fell back to a straight edge-to-centre
spoke. The second lookup hands the glow the same four sources the four track passes draw from, in the
same precedence order.

### HexGridRenderer.tsx #374 → #380 — The hit test moves from the hex to the line
**`#374`** chose a **hex-grained** hit test and defended it: pixel-perfect proximity would mean
re-deriving every authored `Path2D` under its transform and running `isPointInStroke` per frame, "for a
gain the player cannot see: routes run along rails, and a rail occupies its hex." It also ruled that
**a hex on two routes highlights neither** — ambiguity resolves to no answer, because picking one
arbitrarily would have the player hover a shared segment and conclude the wrong train ran it.

**`#380` reverses it, and states why.** The premise was right and the conclusion was wrong: **the gain
is exactly the case `#374` had to special-case** — a shared hex — **and it is not rare, it is the
position that makes route colours worth having at all.**

**The cost was overstated too.** Nothing needs re-deriving per frame: every route stroke already passes
through one function that knows both the authored path and the transform it is drawn under, so the
flattened geometry is a **by-product of the draw that already happened** — built once per repaint, not
once per pointer move.

One `Path2D` per train, in **board** pixels — after the per-hex transform, before the view's pan/zoom —
so the caller strokes it and applies only the view transform. `DOMMatrix` is **required and checked
for**; where missing, the map comes back empty and the caller keeps hex-grained hover rather than
losing hover entirely.

**No hex fallback when the paths exist.** Hovering inside a hex but not on any line now highlights
nothing, **and that is correct: the whole point is that the hex is no longer the unit.**

The flattened geometry is stashed in a **ref, not state** — it changes on every repaint, and
re-rendering React because the hit geometry moved would repaint the canvas, which would rebuild the
geometry.

### HexGridRenderer.tsx #373 — One route is the one being looked at
**Reported:** no visual connection between a route on the map, its train chip on the corporation card,
and its row in the Route Planner.

Three surfaces describing one thing with nothing tying them together. **The colours were always
per-train (`#254`), which is what makes the connection recoverable; it was never made.**

`trainIndex` is the join key — the same index the planner rows and chips are keyed on, so **a single
number held in `App.tsx` is enough for all three to agree**: no id scheme, no registry, and nothing
that can drift because there is only one value.

`emphasis` (`normal`/`primary`/`muted`) is computed **by the caller**, because `drawRouteOverlays` is
also used by callers with no concept of a cursor.

**`#374` is the map's end of it**, and the only one of the three surfaces that has to *work* for the
connection — **on a canvas there are no elements to hover**, so a route path cannot raise an event by
itself.

---

## Preview, cursor and thumbnails

### HexGridRenderer.tsx #167 — The preview is fully opaque
It rendered at `globalAlpha = 0.65` so it would "clearly read as a not-yet-confirmed preview". That
reasoning came from a flow where the preview was the **only** signal something was pending.

**The radial selector changed that:** a green check and a red X float above the hex whenever a preview
is live. The pending state is now stated by a **control**, not implied by transparency — **and
transparency was costing the one thing the preview exists for.** At 0.65 the board colours bled
through, turning a yellow tile over a green hex into a muddy third colour. **The whole point of an
in-situ preview is judging whether the tile fits, and it was being judged through a veil.**

**The dashed outline stays.** It is the cheap half of the old signal — costs no legibility, keeps
working for anyone who cannot see the buttons (which sit above the hex, possibly off-screen on a panned
board), and matches this renderer's existing idiom for provisional artwork.

### HexGridRenderer.tsx #159 / #183 / #496 — The cursor is the piece in your hand
**`#159`:** a crosshair puts the canvas visibly into token-targeting mode. **A mode with no cursor
change is a mode players forget they are in**, and then every subsequent click does something they did
not intend. Targeting beats panning: the player can still pan, they just need to know what a click
does.

**`#183`:** `crosshair` says "you are about to click precisely somewhere", which is true of route
selection and tile laying too — **it marked that a mode was active without saying which.** An inline
SVG cursor showing the token names the mode **at the pointer, where the player is looking**. A data-URI
rather than a file: it is nine elements, **it must not race a network fetch (a cursor that arrives late
is a cursor that flickers)**, and the hotspot must be declared in the same breath as the art. `16 16`
centres it, because **a token is placed AT a point rather than pointed at from a corner**.

**`#496`:** the generic disc was right about the **gesture** and said nothing about **whose** gesture.
On a board where the token about to land is liveried and lettered, **the pointer that places it was the
one unliveried thing in the interaction.**

A **composed PNG**, not the `.webp` referenced directly. Three reasons, the first decisive:

- **`cursor: url(...)` has no error path.** An `<img>` gets `onError`; a CSS cursor that fails to
  decode falls through to the keyword after the comma, so a broken herald would silently become
  `crosshair` and **the feature would look unbuilt rather than broken.**
- **WebP-as-cursor is not uniformly supported.** PNG is what every engine accepts.
- **The herald alone is not a token.** It is artwork on a transparent field; a station token is a
  liveried disc with a rim. Compositing lets the cursor be the **piece**.

The image load is async, so this is state rather than a derivation, and **the fallback is rendered
first** — a liveried disc with the ticker — so the cursor is corporation-specific from the first frame
and merely gets sharper, instead of flickering from generic to branded. 32px because browsers cap
cursors and 32 is the size every engine honours without scaling.

**Both fields together** (`ticker` and `color`) rather than a ticker this component looks a colour up
for: `stationTickerColor` is keyed by `company_id` and the caller holds that id, and **`#428` spent a
whole pass removing the last duplicate of that mapping.**

### HexGridRenderer.tsx #368 — The hex has to fit its own canvas
**Reported:** the radial selector shows previews as rectangles instead of hexagons.

**It was clipped, and by exactly one number.** The thumbnail defaulted to a fixed radius of 40 while
`size` defaulted to 96, compatible only by luck: `drawHexPath` draws a **pointy-top** hex, whose height
is `2R` and whose width is `√3·R`, so a radius of 40 needs an 80px canvas. `RadialTileSelector` passes
`size={38}`, so five sixths of the hex fell outside the bitmap and what survived was the middle band —
**a rectangle. Not a styling problem at all, which is why it reads as one.**

**Derived, so the two can never disagree again:** `(size − 2) / 2` is the largest radius whose 2px tier
stroke still lands inside. **A default rather than a computation at the call site, because the
relationship is a property of the drawing, not of any one caller** — and the bug was a caller being
asked to know it.

`#368` also clips the **element** to the hexagon: the canvas is transparent outside the hex either way,
but a square element means chrome **behind** it shows through the corners and frames the tile as a
card. Clipping makes the preview read as a game piece.

### HexGridRenderer.tsx #488 — Show the pieces, not just a sentence about them
**Reported:** upgrading a multi-city tile gives no way to tell which city node the station ends up on.

`RadialTileSelector #271b` answered this in **words** — "PRR to city 2 of 2". That was the right first
move and is not enough on an OO upgrade, **because the question is spatial**: a caption asks the player
to hold "city 2" in their head, work out which circle the catalog calls city 2, and check it against
artwork they have not seen yet. **The marker just shows them.**

Drawn from **`tileCityAnchors`, which is what the board draws laid tokens against** — that is the whole
point of using it rather than a preview-only approximation: **the circle the player sees here is
computed by the same function that will place the real token**, so the preview cannot promise a node
the board then disagrees with.

**An out-of-range index draws nothing rather than falling back to node 0**: a token silently shown on
the wrong circle is worse than one not shown, since the whole point of this pass is to be believed.

**The ticker is gated on measured size:** below a threshold an acronym stops being text and becomes a
smudge, **and a smudge reads as a rendering fault where a plain disc reads as a decision.** Passing an
empty ticker takes `drawStationTokenMarker`'s own early return, so it is the same primitive at both
sizes rather than a second marker renderer.

---

## Dependencies and staleness

### HexGridRenderer.tsx #138 / #194 — `mapGrid`, not `mapGrid.tiles`
The draw body reads the **whole object** — `hexHasLaidTile`, `archetypeForHex`, `liveEdgesForHex`,
`hexBlockedSlots` and `singleNodeNameplateAnchor` all take `mapGrid` itself. Depending only on `.tiles`
is a narrower key than the closure needs, **which is the definition of a stale-closure hazard**.

**Why this was invisible:** `App.tsx` supplied a frozen mock that never changed, so neither the stale
read nor any extra repaint could be observed. **The hazard only becomes real when this is wired to the
live poll — which is exactly when it would have been hardest to diagnose.**

`handlePointerMove` gained `mapGrid` and `currentEra` for the same reason. **A stale closure here does
not fail loudly; it quietly reports outdated numbers, indefinitely:** `currentEra` selects which
off-board revenue tier the tooltip prints and advances Yellow → Green → Brown, so frozen at first
render every off-board hover would show Yellow-era revenue **for the entire rest of the game** — a
number the contract stopped paying rounds ago.

**Note for callers:** pass a **stable** `mapGrid` reference. An object literal built inline in JSX gets
a new identity every render and would repaint the canvas on every render of the parent.

### HexGridRenderer.tsx #44 — The control cluster left the canvas
It was `position: absolute` inside the canvas container, directly on top of the board's top-right
coordinate labels — **the one part of the map that is pure reference text and therefore the worst thing
to cover.** There is no placement inside a full-bleed canvas that does not cover *something*, so the
controls leave the canvas entirely and sit in normal flow underneath it.

---

## Monolith split (Phases 0–4)

The renderer was ~12,000 lines. It was cut leaf-first into five modules, each extracted only once
nothing it depended on was still inside the parent:

| Phase | Module | Contents |
|---|---|---|
| 0 | `HexGridRenderer.design-notes.md` | the ~3,180-line header block *(now folded into this document)* |
| 1 | `hexTileCatalog.ts` | `TerrainType`, `TileColorTier`, the 46-entry `TILE_CATALOG` mirror, drift tripwires |
| 2 | `hexBoardData.ts` | every static table describing the board |
| 3a | `hexContractTypes.ts` | `MapTileEntry`, `MapGridResponse`, `QueryCapableClient`, `StationTokenCompany`, `HexClickQueryState` |
| 3 | `hexGeometry.ts` | axial system, topology, archetypes, the 13-slot engine, naming/valuation |
| 4 | `hexCanvasPrimitives.ts` | every function that paints |

Two mechanical rules made this verifiable as a pure relocation:

- **Re-export rather than merely import.** `App.tsx` and `TileSelectionPopup.tsx` import several of
  these names from *this* module, so `export … from` keeps every existing import path working and
  `tsc` proves the graph still resolves.
- **`import/first`.** ESLint requires every `import` to precede all other statements, and this file's
  first statement was ~3,300 lines below its own header — **which makes "next to the thing it relates
  to" and "at the top" look like the same place when they are not.** A re-export creates no local
  binding, so the paired `import` at the top does not collide with it.

`hexContractTypes` was extracted **ahead of** the geometry, because the slot engine takes those types
and would otherwise have imported back into this file — a cycle.

---

## Notes referenced but not given their own section

Five numbers are cited from source and were only ever short inline remarks. Recorded here so the
anchor space is complete rather than silently short.

### HexGridRenderer.tsx #17 — Standalone camera buttons
`+`/`−` zoom around the canvas's own screen-space centre (a button click has no cursor to anchor on,
unlike a wheel zoom), and "Fit to Screen" is an explicit, **idempotent** snap back to exactly
`fitView`. Each works **standalone**: `+`/`−` flips `detailedView` on by itself if the camera is still
at the locked baseline, **rather than being a no-op until a separate toggle is clicked first.**
*(The separate "Toggle Detailed View" button was later removed by `#42`; these handlers are unchanged.)*

### HexGridRenderer.tsx #124 — The picker draws its own revenue disc
`showRevenue` defaults **true**, so every isolated rendering of a tile — picker thumbnails, the
rotation preview — carries its value. **The main board loop passes `false`**, because laid hexes already
get a placement-aware badge that knows about off-board tiers and per-hex overrides. **Drawing both would
stamp two different numbers on the same hex.**

### HexGridRenderer.tsx #132 — Revenue comes from the chain
`MapTileEntry.revenue` is `Uint128`, so it arrives as a JSON **string** — parsed in exactly one place.
Precedence is `revenueOverride ?? entry.revenue ?? terrainBaseValue(...)`, **using `??` and never `||`,
because a revenue of `0` is a legitimate answer that must beat the level below it.**

### HexGridRenderer.tsx #229 — New York is a preprinted hex like any other
G19 is authored in its own constant rather than the shared printed catalog, because it prints **two**
stations and `PrintedArtwork.marker` is singular. **That split is right for the DATA and was silently
wrong for every LOOKUP over it** — the path lookups, the edge-pair lookups and the interior-end cache
all indexed the catalog, missed G19, and returned nothing.

**The consequence was invisible until the route glow started resolving individual rails:** a train
stopping at New York resolved no path at all, **so the busiest hex on the board highlighted nothing.**
The previous whole-hex behaviour had masked it by lighting both spurs — **one bug covering another,
which is why fixing the first exposed the second.** `printedTracksFor` is now the single place that
knows about the exception, so every lookup sees the same set of hexes.

### HexGridRenderer.tsx #608 — Floating is not placing
**Reported:** the corporation actually placing its home station token **does not see its own reservation
marker**, while every other corporation's renders normally.

The reserved-badge test said `is_floated`, reasoning that once a company has floated the real token pass
draws it, so drawing the badge too would double up. **True — but only after the token exists, and in
1830 those are two separate moments.** A corporation floats, and *then* its president is prompted to
place the home station. **In the window between, `is_floated` is already true and there is no token yet,
so this skipped the badge and the pass below had nothing to draw: the hex went blank.**

**Which is the worst possible hex to blank.** That window is exactly when the Place Home Station prompt
is open, **so the one player who needs to see where their home is reserved is the only player at the
table who cannot** — and the marker is visibly there for everyone else, which makes it read as "this
corporation has no reservation" rather than as a rendering gap.

**So the test is the TOKEN, which is the fact the old comment actually meant.** Floating no longer comes
into it.

---

## Anchor index — every rail-map `#N` cited from source

The five rail-map modules share one numbering space. Every number below is cited from at least one of
them; this table says which document and section covers it, so a `Ctrl+F` on any number resolves even
where the note is discussed inside a combined section rather than under its own heading.

| Note | Covered in | Section |
|---|---|---|
| `HexGridRenderer.tsx #1` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #1 — Pointy-top axial geometry, reverse-engineered |
| `HexGridRenderer.tsx #6` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #6 — The static board is the authentic 93 hexes |
| `HexGridRenderer.tsx #7` | [canvas_rendering.md](canvas_rendering.md) | Board click routing |
| `HexGridRenderer.tsx #8` | [canvas_rendering.md](canvas_rendering.md) | App.tsx #159 — "Place Station Token" is a real mode toggle |
| `HexGridRenderer.tsx #10` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #10 — Off-board pre-printed track |
| `HexGridRenderer.tsx #11` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #11 — Off-board value plates print both tiers |
| `HexGridRenderer.tsx #12` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #12 — Gray hexes and OO hexes |
| `HexGridRenderer.tsx #13` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #5 / #8 / #13 — Derived fit, clamped pan, locked baseline |
| `HexGridRenderer.tsx #15` | [canvas_rendering.md](canvas_rendering.md) | App.tsx #15 — Restored Boston/New York nameplates |
| `HexGridRenderer.tsx #17` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #17 — Standalone camera buttons |
| `HexGridRenderer.tsx #25` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #20 / #23 / #24 / #25 — The DOM detour, and its reversal |
| `HexGridRenderer.tsx #26` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #28 / #31 — Measure the label, not just the anchor |
| `HexGridRenderer.tsx #27` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #19 / #27 — Viewport maximisation, then true proportional scale |
| `HexGridRenderer.tsx #28` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #28 / #31 — Measure the label, not just the anchor |
| `HexGridRenderer.tsx #29` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #29 → #6b — The edge-reflection formula, and the identity claim that broke it |
| `HexGridRenderer.tsx #31` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #28 / #31 — Measure the label, not just the anchor |
| `HexGridRenderer.tsx #33` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #33 — Transparent margin fills |
| `HexGridRenderer.tsx #34` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #34 / #35 — Blank city hexes and their real values |
| `HexGridRenderer.tsx #35` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #34 / #35 — Blank city hexes and their real values |
| `HexGridRenderer.tsx #36` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #36 — Station token markers |
| `HexGridRenderer.tsx #37` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #103 / #117 / #118 / #287 — What the tooltip says |
| `HexGridRenderer.tsx #38` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #38 — Impassable border edges |
| `HexGridRenderer.tsx #39` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #39 / #70 / #109 — Adaptive placement, and the offset that moved four times |
| `HexGridRenderer.tsx #41` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #41 / #49 / #54c — Stacked dual names move to centre |
| `HexGridRenderer.tsx #42` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #42 — Perpendicular Bezier track splines |
| `HexGridRenderer.tsx #43` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #43 — A floor below the fit |
| `HexGridRenderer.tsx #44` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #44 — The control cluster left the canvas |
| `HexGridRenderer.tsx #45` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #46 / #48 / #116 / #513 / #564 — Token typography and livery |
| `HexGridRenderer.tsx #46` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #46 / #48 / #116 / #513 / #564 — Token typography and livery |
| `HexGridRenderer.tsx #47` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #47 / #364 / #366 — The reservation badge and its tooltip line |
| `HexGridRenderer.tsx #48` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #46 / #48 / #116 / #513 / #564 — Token typography and livery |
| `HexGridRenderer.tsx #49` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #47 / #49 / #69 / #125 — The restriction badge |
| `HexGridRenderer.tsx #51` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #51 (line height) — Font-relative, not zoom-relative |
| `HexGridRenderer.tsx #53` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #133 — Laid tiles win over pre-printed landmark artwork |
| `HexGridRenderer.tsx #54` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #133 — Laid tiles win over pre-printed landmark artwork |
| `HexGridRenderer.tsx #55` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #55 — Strict canvas layering hierarchy |
| `HexGridRenderer.tsx #56` | [hex_tile_math.md](hex_tile_math.md) | `hexCanvasPrimitives.ts` — Everything that paints |
| `HexGridRenderer.tsx #58` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #208 — The plain connectors join the catalog |
| `HexGridRenderer.tsx #61` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #133 — Laid tiles win over pre-printed landmark artwork |
| `HexGridRenderer.tsx #62` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #62 → #66 — Shape-based iconography, and five sizing passes |
| `HexGridRenderer.tsx #63` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #122 — Disjoint paths mean separate runs |
| `HexGridRenderer.tsx #65` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #62 → #66 — Shape-based iconography, and five sizing passes |
| `HexGridRenderer.tsx #66` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #62 → #66 — Shape-based iconography, and five sizing passes |
| `HexGridRenderer.tsx #67` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #67 — Scroll-wheel zoom removed |
| `HexGridRenderer.tsx #68` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #68 / #87 → #102 — The terrain compound badge |
| `HexGridRenderer.tsx #70` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #70 — Thirteen slots |
| `HexGridRenderer.tsx #72` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #72 — Cross-pass slot claiming |
| `HexGridRenderer.tsx #74` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #74 — Nameplates join the ledger |
| `HexGridRenderer.tsx #75` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #75 — Adaptive quadrant |
| `HexGridRenderer.tsx #76` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #76 — Far-side fallback |
| `HexGridRenderer.tsx #77` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #52 / #56 / #58 / #73 / #77 — The two-node coordinate, five passes |
| `HexGridRenderer.tsx #78` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #50 → #54 → #78 → #82 — The shield box, four times |
| `HexGridRenderer.tsx #82` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #50 → #54 → #78 → #82 — The shield box, four times |
| `HexGridRenderer.tsx #83` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #79 → #83 — Wrap, then don't |
| `HexGridRenderer.tsx #84` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #84 — One shield for two lines |
| `HexGridRenderer.tsx #85` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #78c / #85 — The off-board block |
| `HexGridRenderer.tsx #87` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #68 / #87 → #102 — The terrain compound badge |
| `HexGridRenderer.tsx #89` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #68 / #87 → #102 — The terrain compound badge |
| `HexGridRenderer.tsx #95` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #68 / #87 → #102 — The terrain compound badge |
| `HexGridRenderer.tsx #97` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #68 / #87 → #102 — The terrain compound badge |
| `HexGridRenderer.tsx #98` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #86 → #100 — The water icon, seven passes and one misread |
| `HexGridRenderer.tsx #99` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #68 / #87 → #102 — The terrain compound badge |
| `HexGridRenderer.tsx #100` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #86 → #100 — The water icon, seven passes and one misread |
| `HexGridRenderer.tsx #102` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #68 / #87 → #102 — The terrain compound badge |
| `HexGridRenderer.tsx #104` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #104 — Minimum 120° angular separation |
| `HexGridRenderer.tsx #105` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #105 — Preferences tuned, claim order fixed |
| `HexGridRenderer.tsx #106` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #106 — The primary list must be searched to exhaustion first |
| `HexGridRenderer.tsx #109` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #39 / #70 / #109 — Adaptive placement, and the offset that moved four times |
| `HexGridRenderer.tsx #111` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #111 / #112 — An explicit override needs its own resolution path |
| `HexGridRenderer.tsx #115` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #113 / #114 / #115 — Force, for "show me anyway" |
| `HexGridRenderer.tsx #116` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #588 — The veil was painting over the tokens |
| `HexGridRenderer.tsx #118` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #118 — Terrain became a real charge |
| `HexGridRenderer.tsx #119` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #121 — Canonical double-town artwork, drawn explicitly |
| `HexGridRenderer.tsx #120` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #120 / #139 — The picker's offline path |
| `HexGridRenderer.tsx #121` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #121 — Canonical double-town artwork, drawn explicitly |
| `HexGridRenderer.tsx #122` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #122 — Disjoint paths mean separate runs |
| `HexGridRenderer.tsx #123` | [hex_tile_math.md](hex_tile_math.md) | TileGraphics.ts — The three canonical primitives |
| `HexGridRenderer.tsx #124` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #124 — The picker draws its own revenue disc |
| `HexGridRenderer.tsx #125` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #125 — Offline mode stopped filtering by era |
| `HexGridRenderer.tsx #126` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #126 / #127 / #129 — One implementation of what a value looks like |
| `HexGridRenderer.tsx #127` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #126 / #127 / #129 — One implementation of what a value looks like |
| `HexGridRenderer.tsx #129` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #126 / #127 / #129 — One implementation of what a value looks like |
| `HexGridRenderer.tsx #131` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #131 — "Art, not math" |
| `HexGridRenderer.tsx #132` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #132 — Revenue comes from the chain |
| `HexGridRenderer.tsx #133` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #133 — Laid tiles win over pre-printed landmark artwork |
| `HexGridRenderer.tsx #134` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #134 — Per-slot token placement |
| `HexGridRenderer.tsx #135` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #135 — The revenue precedence chain |
| `HexGridRenderer.tsx #136` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #136 — Terrain fees are per-hex, not per-type |
| `HexGridRenderer.tsx #137` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #137 — Traced train routes |
| `HexGridRenderer.tsx #138` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #138 / #194 — `mapGrid`, not `mapGrid.tiles` |
| `HexGridRenderer.tsx #141` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #141 — The four static board gates |
| `HexGridRenderer.tsx #150` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #150 — A laid tile covers the preprint |
| `HexGridRenderer.tsx #151` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #151 / #487 — Docking radius and ring width |
| `HexGridRenderer.tsx #152` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #152 → #161 — Two palette passes |
| `HexGridRenderer.tsx #154` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #154 — Which edges each authored path connects |
| `HexGridRenderer.tsx #159` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #159 / #183 / #496 — The cursor is the piece in your hand |
| `HexGridRenderer.tsx #160` | [canvas_rendering.md](canvas_rendering.md) | App.tsx #160 / #172 — Which query statuses open the ring |
| `HexGridRenderer.tsx #161` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #152 → #161 — Two palette passes |
| `HexGridRenderer.tsx #167` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #167 — The preview is fully opaque |
| `HexGridRenderer.tsx #171` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #171 / #506 / #516 — Anchor to the hex, not the cursor |
| `HexGridRenderer.tsx #172` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #172 — Say so, rather than returning silently |
| `HexGridRenderer.tsx #183` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #159 / #183 / #496 — The cursor is the piece in your hand |
| `HexGridRenderer.tsx #208` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #208 — The plain connectors join the catalog |
| `HexGridRenderer.tsx #209` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #209 — There is no procedural branch any more |
| `HexGridRenderer.tsx #210` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #221 — The preprinted station moved; the token did not |
| `HexGridRenderer.tsx #211` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #211 — Preprinted track is drawn, not derived |
| `HexGridRenderer.tsx #215` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #215 / #225 — Preprinted hexes traverse precisely too; an endpoint uses one rail |
| `HexGridRenderer.tsx #216` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #216 / #226 — The glow is `Path2D` all the way down |
| `HexGridRenderer.tsx #217` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #217 — Two spokes are only a route if they meet |
| `HexGridRenderer.tsx #221` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #221 — The preprinted station moved; the token did not |
| `HexGridRenderer.tsx #222` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #222 — Tokens are drawn last, not merely late |
| `HexGridRenderer.tsx #223` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #223 — The wild blue yonder |
| `HexGridRenderer.tsx #225` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #215 / #225 — Preprinted hexes traverse precisely too; an endpoint uses one rail |
| `HexGridRenderer.tsx #226` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #216 / #226 — The glow is `Path2D` all the way down |
| `HexGridRenderer.tsx #229` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #229 — New York is a preprinted hex like any other |
| `HexGridRenderer.tsx #242` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #242 — The display name is not the hex's identity |
| `HexGridRenderer.tsx #244` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #244 → #277 — Cutting the terminal rail |
| `HexGridRenderer.tsx #251` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #251 — A pill has slots; dock into one |
| `HexGridRenderer.tsx #252` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #252 — An outer glow, not a ring with a shadow |
| `HexGridRenderer.tsx #267` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #267 — The route stops at the city wall |
| `HexGridRenderer.tsx #268` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #255 → #268 — Three attempts at a route line |
| `HexGridRenderer.tsx #277` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #244 → #277 — Cutting the terminal rail |
| `HexGridRenderer.tsx #287` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #103 / #117 / #118 / #287 — What the tooltip says |
| `HexGridRenderer.tsx #288` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #288 — The landmark hubs upgrade like anything else |
| `HexGridRenderer.tsx #318` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #318 / #364 — The private company reservation badge |
| `HexGridRenderer.tsx #364` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #47 / #364 / #366 — The reservation badge and its tooltip line |
| `HexGridRenderer.tsx #365` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #365 / #383 — The tooltip waits |
| `HexGridRenderer.tsx #366` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #47 / #364 / #366 — The reservation badge and its tooltip line |
| `HexGridRenderer.tsx #367` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #367 → #377 — The veil deleted, then restored asymmetrically |
| `HexGridRenderer.tsx #368` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #368 — The hex has to fit its own canvas |
| `HexGridRenderer.tsx #373` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #373 — One route is the one being looked at |
| `HexGridRenderer.tsx #374` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #374 → #380 — The hit test moves from the hex to the line |
| `HexGridRenderer.tsx #377` | [canvas_rendering.md](canvas_rendering.md) | App.tsx #377 — Whose veil is it |
| `HexGridRenderer.tsx #380` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #380 / #381 — The hit test lives with the draw |
| `HexGridRenderer.tsx #381` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #380 / #381 — The hit test lives with the draw |
| `HexGridRenderer.tsx #383` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #365 / #383 — The tooltip waits |
| `HexGridRenderer.tsx #453` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #453 / #557 — Which city, not just which hex |
| `HexGridRenderer.tsx #459` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #459 — Which of the two preprinted circles |
| `HexGridRenderer.tsx #463` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #463 — The node, not just the hex |
| `HexGridRenderer.tsx #469` | [canvas_rendering.md](canvas_rendering.md) | App.tsx #620 — The network filter belongs to whoever may lay |
| `HexGridRenderer.tsx #472` | [canvas_rendering.md](canvas_rendering.md) | App.tsx #472 — The open hex, derived |
| `HexGridRenderer.tsx #473` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #153 → #161 → #473 — Track ink |
| `HexGridRenderer.tsx #486` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #486 — The same argument applies to the tile-level label |
| `HexGridRenderer.tsx #487` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #151 / #487 — Docking radius and ring width |
| `HexGridRenderer.tsx #488` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #488 — Show the pieces, not just a sentence about them |
| `HexGridRenderer.tsx #496` | [canvas_rendering.md](canvas_rendering.md) | App.tsx #496 — Whose token the cursor is carrying |
| `HexGridRenderer.tsx #505` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #269 / #505 — Three tooltip states, not two |
| `HexGridRenderer.tsx #506` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #171 / #506 / #516 — Anchor to the hex, not the cursor |
| `HexGridRenderer.tsx #515` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #515 — The ring frames the slot, not the hex |
| `HexGridRenderer.tsx #516` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #171 / #506 / #516 — Anchor to the hex, not the cursor |
| `HexGridRenderer.tsx #557` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #585 — Slot rings are for home stations only |
| `HexGridRenderer.tsx #561` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #561 — A legality cue is not a livery |
| `HexGridRenderer.tsx #564` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #46 / #48 / #116 / #513 / #564 — Token typography and livery |
| `HexGridRenderer.tsx #584` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #584 — Ask the marker where the home slot is |
| `HexGridRenderer.tsx #585` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #585 — Slot rings are for home stations only |
| `HexGridRenderer.tsx #588` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #588 — The veil was painting over the tokens |
| `HexGridRenderer.tsx #608` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #608 — Floating is not placing |
