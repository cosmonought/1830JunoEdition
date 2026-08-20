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
