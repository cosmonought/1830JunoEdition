# Hex Tile Math — Artwork, Geometry, the Slot Engine and Board Data

`components/hexCanvasPrimitives.ts` (everything that paints), `components/hexGeometry.ts`
(everything that answers *where*), `components/TileGraphics.ts` (the hand-authored artwork catalog)
and `components/hexBoardData.ts` (the 1830 board as data).

> ## One numbering space, five files
>
> These four modules were **extracted out of `HexGridRenderer.tsx`** (Phases 1–4 of the monolith
> split) and **kept their design-note numbers**, because the split was a pure relocation. So
> `#209` in `hexCanvasPrimitives.ts` and `#209` in `HexGridRenderer.tsx` are **the same note** — the
> renderer family shares a single `#N` space rooted in the original file.
>
> Every note in this document is therefore anchored **`HexGridRenderer.tsx #<N>`**, the same form
> [canvas_rendering.md](canvas_rendering.md) uses, so `Ctrl+F` on a number resolves no matter which
> of the five files the code now lives in. The heading says which module owns it today.

---

## Module boundaries

### HexGridRenderer.tsx #4 (redraw strategy) — Two redraw paths
Prop-driven redraws (new `mapGrid`, a resize, a `hexSize` change) go through a plain `useEffect` —
simplest and cheapest for state that changes only when new chain data arrives. Pointer-driven
pan/zoom goes through a `requestAnimationFrame`-coalesced scheduler, so a burst of
`pointermove`/`wheel` events collapses to **at most one repaint per animation frame** rather than one
per event.

### `hexCanvasPrimitives.ts` — Everything that paints
The boundary is mechanical and unusually clean: **with two deliberate exceptions, everything here
takes a `CanvasRenderingContext2D` and returns nothing, and nothing here knows what React is.**
Verified mechanically before extraction — zero occurrences of `useState`/`useEffect`/`useMemo`/
`useCallback`/`useRef`/`React` in the whole block. That is what makes it a utility module rather than
a second component: these can be called from a worker, a test, or an offscreen canvas.

**The two non-`ctx` exceptions, both deliberate:** `stationMarkerPoint` and `twoCityStationPoints`
compute *where* a station marker goes. They look like geometry, but **they exist to keep the token and
the circle it sits on in lockstep, and both callers are here** — split across files, the two could
drift, which is exactly the bug `#56` fixed. And `DOUBLE_TOWN_ROUTES` is artwork data consumed only by
`drawDoubleTownRoute`.

### `hexGeometry.ts` — Everything that answers *where*
The axial system, board topology, the archetype classifier, the 13-slot engine and the naming/valuation
lookups. **No canvas, no React, no DOM — not one function takes a `CanvasRenderingContext2D`.**

**The slot engine is the reason this file is worth having.** It is roughly a thousand lines of
placement logic with four layered override mechanisms, and **every one of them exists because a real
label collided with something on a real hex.** The tables look arbitrary and are not.

### `hexBoardData.ts` — The board as data
Every export is either a literal table or a pure function of one. **Almost every table was
verbatim-sourced** from `tobymao/18xx`'s `g_1830/map.rb` and cross-checked against the Rust backend's
constants. **The comments travel with the data deliberately: a coordinate table with no provenance is
unauditable, and several entries exist because an earlier pass got them wrong.**

### Import direction is one-way
None of these four may ever import from `HexGridRenderer.tsx`. Extraction was strictly **leaf-first**,
which is what kept every step free of circular imports: board data depends on exactly one thing outside
itself (`TileColorTier`, moved in Phase 1); geometry reads board data; the canvas primitives read
geometry.

---

## Track geometry — the Bezier system

### HexGridRenderer.tsx #3 — Track rendering is this file's convention, not the backend's
`hexmap.rs` documents that a tile's connection bitmask "records which of its six edges carry a track
stub, **not how those edges pair up internally**". For a two-live-edge tile this drew one path between
them; for three or more, a spoke from each live edge into a shared centre node, **since the bitmask
alone does not say which pairs route together.** A legible, honest simplification, not a claim about
real 1830 tile art. *(Superseded outright by `#131`/`#208`/`#209` — see below.)*

### HexGridRenderer.tsx #42 — Perpendicular Bezier track splines
`edgeInwardNormal(i)` is the unit vector from edge `i`'s midpoint toward hex centre — `edgeAngleRad(i)`
gives the outward direction, so the inward normal is that angle plus 180°.

`bezierTrackSegment` strokes one **cubic** Bezier, replacing the file's previous `quadraticCurveTo`
curves. Each endpoint's control point is projected **inward along its own edge normal** by
`hexSize · controlFraction` (default `0.3`, within the 25–35% band the requirement names). **Since a
cubic Bezier's tangent at an endpoint points directly at its adjacent control point, this guarantees
the curve crosses that edge perpendicular to it** — a true 90° crossing, regardless of which way it
bends inside.

An endpoint with **no** normal (a hex-centre station node, which has no single face to be
perpendicular to) falls back to the straight chord direction, so the curve eases smoothly through the
shared node rather than kinking at a zero-length control point.

`#42` also gave the file `withHexClip` (a `save`/hex-path/`clip`/`restore` wrapper so nothing bleeds
past a hex border), `fillTextWithHalo`, and the crisp `#E53E3E` impassable-border bar clamped to a
literal 3–4px — the old unclamped `max(5, size · 0.16)` read wider than an ordinary barrier at most hex
sizes and **had no upper bound at all**.

### TileGraphics.ts — The three canonical primitives
**Unit hex.** Origin at hex centre, +x east, **+y south** (canvas convention), circumradius exactly 1.
The renderer scales by `hexSize` and translates; **nothing here needs to know the pixel size.**

Every path starts and ends **exactly** on an edge midpoint (or dead-ends in the interior, for #59's
terminal spurs), and every endpoint tangent is **exactly** along that edge's inward normal. **That is
not a stylistic preference — track has to meet its neighbour square across the hex boundary or the
rail map visibly kinks at every seam.**

Real 1830 cardboard draws exactly **three** track shapes. Each is a true circular arc, transcribed as
the cubic Bezier that reproduces it (control length `k·r`, `k = 4/3 · tan(θ/4)`):

| Shape | Edge separation | Geometry | Control length | Closest approach to centre |
|---|---|---|---|---|
| **Straight** | \|Δ\| = 3 | a literal `L` through hex centre | — | 0 |
| **Gentle** | \|Δ\| = 2 | arc of radius **1.5R** centred on the far neighbouring hex's corner, 60° sweep | 0.535898 | 0.232051 |
| **Sharp** | \|Δ\| = 1 | arc of radius **0.5R** centred on the hex **corner the two edges share**, 120° sweep | 0.384900 | 0.5 |

A city or town marker on a curve sits at that curve's **apex**, which is where the cardboard prints it.
Where two revenue centres would collide, **the marker slides along its own track until it is clear.**

> **`#123`'s rule, restated and now global: the markers move around the geometry, the geometry never
> moves around the markers.**

Edge midpoints in unit space: `edge 0 E (0.866025, 0)`, `1 NE (0.433013, −0.75)`,
`2 NW (−0.433013, −0.75)`, `3 W (−0.866025, 0)`, `4 SW (−0.433013, 0.75)`, `5 SE (0.433013, 0.75)`.

### HexGridRenderer.tsx #131 — "Art, not math"
`drawHardcodedTileArtwork` is the **first statement** in `drawTrackPath`, ahead of
`rotateConnections`/`liveEdges` and every procedural branch, **so a catalogued tile cannot reach them
even by accident.** Everything below its `return true` is literal `Path2D` playback of a hand-written
`d` string: no control point is computed, no offset derived.

**Adding a tile to `TILE_GRAPHICS_CATALOG` is therefore the whole mechanism** for taking it off
procedural generation — there is no second switch to flip and no way for two renderers to disagree
about one tile, because only one of them ever runs.

**Orientation is a rigid `ctx.rotate` about the hex centre** — the tile is turned, exactly as cardboard
is turned. `−60 · orientation` matches `edgeAngleRad`'s own convention, so base edge `i` lands on live
edge `(i + orientation) % 6`, **agreeing with `rotateConnections` by construction rather than by
coincidence.**

**Track is stroked before markers, always, and markers are drawn outside the rotated/scaled
transform**, in plain board pixels. Two reasons, both load-bearing: a crossing arm (#55/#68's two
straights meet at centre) **must never be stroked over a station it passes**, and a circle drawn under
`ctx.scale(size, size)` would take its **stroke width from the transform** and stop matching every
other marker on the board.

### HexGridRenderer.tsx #208 — The plain connectors join the catalog
The catalog's original scope decision read: "plain connector track is deliberately absent — it carries
no revenue centre, nothing about it was wrong, and it keeps using the existing renderer." **Two of
those three clauses were mistaken, and the third was the trap.**

- **"Nothing about it was wrong"** — it was. With three or more live edges the procedural renderer
  fanned every edge into hex centre. **#28 (edges 0/4/5) and #29 (edges 0/1/2) both came out as the
  same three-armed Y of straight radial spokes** — identical to each other, and neither resembling the
  tile. They are in fact **mirror images**, each a gentle and a sharp curve forking off a shared edge:
  two smooth curves, no straight lines, no junction in the middle. **The bitmask cannot express that
  and no function of it can recover it.**
- **"It carries no revenue centre"** — true, and irrelevant. The catalog is not about markers; it is
  about the track being **art rather than a guess**.
- **"It keeps using the existing renderer"** — this is the trap. **Plain connectors are the most-laid
  tiles in 1830 by a wide margin**, so "everything except the connectors" meant most of the board was
  drawn by the very path the catalog exists to retire.

Nothing in the 24 added entries is a new shape: **#7 is the same sharp arc #3 draws, #8 the same
gentle #58 draws, #9 the same straight #57 draws.** That is the point — the tray prints one vocabulary,
and **a connector is a city tile with the city left off.**

**Where two paths share an edge** (#23–#29, #39–#47, #70) both curves are drawn in full from that
shared midpoint. They overlap for the first fraction of their length and then diverge, **which is
exactly how the cardboard prints a fork — not a Y-junction meeting at a node.**

### HexGridRenderer.tsx #209 — There is no procedural branch any more
The `DoubleTown` route table, the disjoint-paths renderer, the `cityGroups` two-station branch, the
two-live-edge shortcut and the fan-to-centre fallback are all **deleted**, not left behind an
unreachable guard.

**Why deleted and not kept as a fallback.** Every one read the flat `connections` bitmask, which
records which edges are live and **cannot record which pairs route together**. That is a limitation of
the **data**, not of the code. **A fallback that is guaranteed to be wrong whenever it runs is not a
safety net; it is a silent renderer of plausible-looking fiction** — and leaving it in place means the
next tile added without artwork looks fine and is not.

An id with no artwork gets the explicit placeholder: a dashed outline and the tile number, **legible as
"this build does not know this tile" and impossible to mistake for track.**

`drawTileMarkers` went with it (`#209`): it placed a marker by **terrain type alone**, which is the
marker half of the same guess — **terrain says what *kind* of revenue centre a tile carries and cannot
say *where* the cardboard prints it**, which is why a two-city tile ended up with a station in the empty
half of the hex.

### HexGridRenderer.tsx #211 — Preprinted track is drawn, not derived
The same correction one layer over. `drawPrintedTrack` built its shape from an **edge set** — and on
preprinted hexes that was **worse** than on tiles, because the half-curve **degenerates**:
`bezierTrackSegment(edgeMidpoint → centre, inwardNormal, null)` puts **both** control points on the
straight line between its endpoints, so the "curve" is a straight radial. **Cleveland's 60° pair
therefore drew as a hard V through the middle of the hex.**

It now renders `PRINTED_GRAPHICS_CATALOG[label]` — literal `d` strings in the same unit-hex space,
same three primitives, marker on the curve's own apex. **A gray hex connecting edges 0 and 2 and a laid
#8 connecting edges 0 and 2 are now the same drawn shape, which they always should have been and never
were.**

Altoona's "some trains skip this stop" fork was a run of control-point arithmetic bowed off the chord
by a tuned `size * 0.8`; **it is one more path string now.**

**Not rotatable, which is why it is a separate table.** A preprinted hex has one fixed orientation
baked into the board — `GRAY_HEXES` stores **absolute** edge numbers, not a base set plus a rotation.

**The edge sets are not restated here.** They live in `hexBoardData`, which is what `liveEdgesForHex`
reads for connectivity and legality; duplicating them would create exactly the drift the tile half
guards against.

### HexGridRenderer.tsx #121 — Canonical double-town artwork, drawn explicitly
**Reported:** #55 — simply two straights crossing in an X — came out with both arms visibly bowed, and
#56's two gentle curves were warped enough to be hard to read.

**The cause was a priority inversion in `#119`.** That pass routed each town's track through its own
offset node so the two dits could not collide at centre. **In other words it moved the TRACK to make
room for the MARKERS.** For the two tiles whose whole character is a straight line, that is exactly
backwards: **a straight that bows is no longer the tile.**

**Fixed by abandoning the general algorithm.** There are exactly five double-town tiles in all of 1830
and there will never be a sixth, so `DOUBLE_TOWN_ROUTES` states each one's artwork explicitly:

| Tile | Edge pairs | Shape |
|---|---|---|
| #1 | {0,4} + {1,3} | two gentle curves (d=2, d=2) |
| #2 | {0,3} + {1,2} | straight + sharp curve (d=3, d=1) |
| #55 | {0,3} + {1,4} | **two straights: the X** (d=3, d=3) |
| #56 | {0,2} + {1,3} | two gentle curves (d=2, d=2) |
| #69 | {0,3} + {2,4} | straight + gentle curve (d=3, d=2) |

**Opposite edges take a literal `lineTo`** — not a Bezier that happens to look straight, **so #55's X
cannot bow by even a pixel.** Everything else takes **one** cubic Bezier with control points on each
endpoint's inward normal at the standard `0.3` reach, which yields a tight corner for a 60° pair and a
shallow bow for a 120° pair **with no per-shape fudging.**

`drawDoubleTownRoute` **reports the point halfway along what it actually drew**, so the dit follows the
track instead of the track following the dit. **Only #55 needs a marker rule of its own**, because it
is the only tile whose routes are both straights and therefore share a midpoint at dead centre — its
dits slide out along their own arms, **moving the markers, never the geometry.**

An explicit table also **beats a general algorithm** on three counts: it reads as "this is what #55
looks like", it cannot produce a surprise on some orientation nobody tested, and **each entry can be
checked against a photograph of the physical tile.** A dev-mode tripwire cross-checks it against
`TILE_CATALOG`, so the duplication cannot silently drift.

### HexGridRenderer.tsx #122 — Disjoint paths mean separate runs
`pathsAreDisjoint` is the whole basis for choosing a rendering, **and it is read off the catalog rather
than guessed.** A junction tile's path list names every through-route across a shared node — **#14
lists all six pairs among its four edges, #63 all fifteen among its six.** Drawing those as separate
curves would be spaghetti; they mean "everything meets in the middle", which is exactly the fan. **A
disjoint list means the opposite:** #16's `[[0,2],[1,3]]` is two tracks that never touch, and fanning
them into one node **invents a connection the tile does not have.**

---

## Route overlays: tracing the real rail

### HexGridRenderer.tsx #154 — Which edges each authored path connects
The overlay wants to trace along the **real rails**, which means knowing, for a tile at a rotation,
which of its paths runs between the entry and exit edges. **That mapping is not stored anywhere** —
`tracks` is raw SVG and `TileCatalogEntry.paths` covers only five tiles.

**It does not need to be stored, because it is derivable.** Every authored path begins and ends on an
edge midpoint, so **reading the first and last coordinate pair out of the `d` string and matching each
against the six known midpoints recovers the pair exactly** — no second data table to keep in sync,
which is the failure mode a hand-written mapping would have. Parsed once per tile and cached.

**The interior dead-ends are why this returns `null` per path rather than assuming success:** #59's
spurs genuinely terminate mid-hex and belong to no edge.

**The `null` is load-bearing, not a failure.** A multi-spoke hub (#14, #15, #53, #61, #63) authors its
track as N separate **spokes**, each running edge → centre: `M 0.866025 0 L 0 0`. **Half of every such
path legitimately has no edge.** Collapsing those to a single `null` — as a first cut did — threw away
exactly the information needed to trace a route **through** a hub, **which is where routes actually
stop.**

### HexGridRenderer.tsx #217 — Two spokes are only a route if they meet
The spoke-joining rule exists for **hubs**. Applied blindly it also fires on the tiles it must not:
**#59 (green "OO") and New York's preprinted hex author terminal spurs — two arms that stop at two
different stations and never touch.** Their edge pairs look identical to a hub's from the outside (one
end on an edge, one in the interior), so a player chaining a route through such a hex would have had
**both spurs lit as though a train ran between them. The tile's whole point is that it cannot.**

**So the join now requires the two arms' interior endpoints to coincide.** A hub's arms all end at the
same station and pass; a spur pair ends at two separated stations and is refused. Comparison is in
**base (unrotated) space**, which is sound because orientation is a rigid rotation: **two points that
coincide before it coincide after it.**

### HexGridRenderer.tsx #215 / #225 — Preprinted hexes traverse precisely too; an endpoint uses one rail
**`#215`:** preprinted hexes had no equivalent of the per-tile traversal lookup, so the overlay could
only trace a gray hex's rails **wholesale** — correct in shape, but on a hex with a branch it lit track
the train does not use. **The matching logic is identical, so it is shared; the only difference is the
rotation, which for a preprinted hex is always zero.**

**`#225`:** a route's two **endpoints** have only one edge each — there is no entry-to-exit pair,
because the train arrives and stops. Tracing every rail on the hex is wrong exactly as reported:
**New York prints two physically disconnected spurs, so a train ending at the NE station lit both, and
the map claimed the corporation ran to a city it never reached.**

**When several paths share an edge the first is taken**, and that is not a coin-flip in practice: the
tiles that fork off a shared edge are all **plain connectors with no revenue centre**, and a route only
ever *ends* at a revenue centre — **so an endpoint hex has at most one authored path per edge, and the
ambiguous case is unreachable by a well-formed route.**

### HexGridRenderer.tsx #216 / #226 — The glow is `Path2D` all the way down
Two procedural fallbacks are deleted, and the second was the reported "straight lines to the hex
centre" outright:

- **Fallback A** re-derived a connecting segment whenever the artwork lookup missed. **It missed
  constantly, because the catalog covered 22 of 46 tiles.** It now covers all 46.
- **Fallback B** drew two half-curves, edge → centre and centre → edge. **That construction is a
  straight line by arithmetic, not by accident:** the first control point goes out along the inward
  normal, which points exactly at the centre, and the second goes back along the chord — both collinear
  with the straight edge-to-centre segment, **so the cubic degenerates.** A two-hex route was two of
  those meeting at a shared edge: **one straight bar spanning two hex centres, which is precisely the
  symptom.** There is no "and also make it curve" version of that code, **because the shape it wanted
  never existed as a curve.**

**`#226` removed the last exception.** A third branch re-ran the whole hex's renderer, lighting every
rail on it — **reached by both endpoints of every route**, which made it the common case rather than a
fallback. `TrackTraceStyle`/`applyTrace` and `HexRailSpec`/`traceHexRails` went with it: **the
guarantee they provided (glow uses the same geometry as the rails) is now structural rather than
mechanical**, because the glow strokes the very same `Path2D` objects the renderers stroke.

What remains is **one rule applied four ways**: stroke the authored `Path2D` the train actually ran
along, and nothing else — laid tile or preprinted hex, both edges or one. **Nothing matches, nothing is
drawn:** a hex whose track does not connect the edges the player chained through has no rail to
highlight, and **the gap in the ribbon is the honest rendering of a route that does not join up.**

### HexGridRenderer.tsx #255 → #268 — Three attempts at a route line
Worth recording the whole arc, because **each step was a reaction to the previous one overshooting**:

1. **An opaque bar** at `size · 0.17` — **wider than the `0.12` rail**, so it replaced the track
   artwork rather than marking it.
2. **A translucent halo** (`#245`) — two wide low-alpha passes with a heavy shadow. It stopped covering
   the rail and **started muddying it**: translucent colour over hand-authored artwork tints everything
   it crosses without ever reading as a definite line.
3. **A solid line, thinner than the rail, drawn on top of it.**

**The third works because of the width relationship rather than in spite of it.** At 55% of the rail's
width the track's own dark ink remains visible on both sides, so the artwork still reads as track while
the line reads as a route drawn along it — **a coloured thread laid in the groove rather than a wash
over the tile.**

**`#268` revises it twice, and the second reverses a decision `#255` argued for:**

- **Width: 55% → exactly one third.** 55% left the rail's ink showing as two thin slivers — enough to
  prove the track is there and not enough to read as track. At a third the route **unambiguously sits
  in the groove rather than filling it.**
- **The shadow comes back.** `#255` removed it, and that reasoning was sound **for the line it was
  describing**: a soft edge on a **wide bar** costs definition. It does not follow for a line a third
  the width of the rail — **a hairline of flat colour on a dark board reads as an artefact rather than
  a deliberate mark. The glow is what makes a thin line legible, not what blurs a thick one.**

**Two passes over the same authored path:** a shadowed **glow** pass (canvas blooms symmetrically, so a
thin stroke with a wide blur is a halo with nothing solid in it), then a **core** pass with shadow off,
fully opaque, landing exactly on the halo's centre. **A single shadowed stroke gives a line whose own
edges are soft;** drawing the core again keeps `#255`'s crispness *and* adds the halo. The blur scales
with `size`, so the halo is the same relative weight at every zoom.

`#373`'s emphasis is applied as **width and alpha, never colour** — **the colour is the route's
identity, and changing it to signal a hover would break the very correspondence this feature exists to
make visible.** The muted pass stays **fully drawn** rather than skipped: **a route that vanishes while
you hover its neighbour is worse than one that recedes, because the player loses the comparison they
were making.**

### HexGridRenderer.tsx #267 — The route stops at the city wall
**Reported:** the route marker "sloppily runs over the top of station tokens".

**Structural rather than a stray few pixels:** the route is stroked along the tile's **authored rail**,
and an authored rail **runs straight through the middle of the city it serves**. The station circle is
painted on top by a later pass. So a route through a city was, by construction, a coloured line drawn
across whatever tokens were in it.

**The fix is a hole rather than a shortened line.** Trimming would mean re-deriving where each curve
enters and leaves each marker — per tile, per rotation, per slot count — **which is the class of
arithmetic `#216` deleted for being wrong more often than the artwork it replaced.** Instead the
marker's outline becomes a **clip exclusion**, and the stroke does not land inside it.

That gives the asked-for behaviour **for free and exactly**: the line stops at the marker's border
radius and **restarts where the rail leaves it, because it is one unbroken stroke with a bite taken
out.** Curves, pills, rotations and multi-city tiles all fall out of the same rule.

**The shapes mirror the marker pass exactly, and must:** the radii are read from the same
`0.22`/`PILL_SLOT_SPACING` constants the markers draw with, **plus half the ring stroke**, so the hole
is the marker's **outer** edge rather than a guess near it. **A drift shows up as a sliver of route
colour around a token — which is the bug this fixes, in miniature.**

**Towns are not masked.** A dit is a small filled dot the route legitimately runs through — it holds no
token, so punching a hole would break the line for no reason.

With `"evenodd"`, a point inside a marker outline has crossing number 2 and falls outside the clip;
everywhere else has 1 and survives. **The universe rect is deliberately absurd rather than measured** —
it only has to contain the board, and the canvas has already clipped to itself.

### HexGridRenderer.tsx #244 → #277 — Cutting the terminal rail
**`#244`:** `#225` resolved an endpoint to the **whole** authored rail meeting the entry edge — right
rail, and on a through-tile it is the **whole** rail. Enter #57 (a straight through a central station)
from the east and the glow ran **east edge → city → west edge**, claiming the train continued out the
far side of a city it terminates in. **Hub tiles were already correct by accident of how they are
authored**, their spokes ending at the centre.

`Path2D` cannot be partially stroked, so **the cut happens on the `d` string before the path is
built.** **Splitting is exact, not approximated:** every authored path is a single segment — one `L` or
one `C` after the `M` — so a line splits by interpolation and a cubic by **de Casteljau**, both
producing a curve that lies exactly on the original. **The only estimated quantity is where the marker
sits along it**, found by sampling; being a pixel off along a curve the glow is already tracing is
invisible, whereas a re-derived approximation of the curve itself would not be.

**A marker not on this rail leaves it whole** — #55's two straights cross, so each carries one town and
not the other.

**`#277`:** `#244` cut at the marker's **centre point** and `#267` punched a hole at its outer radius,
so on screen the line appeared to stop. **Two things were still wrong, and both are about the
difference between hiding a line and not drawing it:**

- **The glow leaked.** `#268` strokes a shadowed pass under the crisp one, and **a shadow blooms
  outward from wherever its source is.** A source running to the marker's centre blooms symmetrically,
  so colour bled around the token no matter how the clip was set — **the clip removes the stroke inside
  the hole, not the glow the stroke casts before it gets there.**
- **A pill is not a circle.** Cutting at a capsule's centre leaves the rail crossing half the capsule,
  under one of the two tokens, before the clip catches it.

**So the cut moves to the perimeter**, and **distance is measured to the marker's *spine***, which is
what makes one formula cover both shapes: **a 1-slot city's spine is a point and the locus at distance
`r` is a circle; a pill's spine is the segment between its two end circles and the locus at distance
`r` is exactly the capsule outline.** No branch, no second radius.

**`#244` also skipped markers at `t = 0` or `t = 1`**, reasoning a marker at an **end** cuts nothing off
— **true of a centre cut and false of a perimeter one**, and it exempted the single largest group of
city tiles: **every hub authors its rails as spokes running edge → centre, so its marker is at `t = 1`
by construction — 23 of the board's 53 city-tile edges took that branch and drew the full spoke into
the middle of the station.**

**A zero-length path is not emitted**, because `lineCap: "round"` renders it as **a dot floating on the
station**.

Sampling rather than solving: **the crossing of a cubic with a capsule has no clean closed form**, the
curve is short, and 256 steps over a unit hex resolves to well under a screen pixel at any zoom.

### HexGridRenderer.tsx #380 / #381 — The hit test lives with the draw
This began inside the pointer handler, **which is where a pointer handler's logic belongs — until you
try to test it**, and find that reaching it means mounting a React component around a real canvas to
synthesise a `PointerEvent`.

**More importantly, the correctness argument is about the draw.** Every line exists to mirror something
`drawRouteOverlays` did — its transform, its pen width, its caps and joins. **Two functions in one file
that must agree can be read together; the same pair 1,600 lines apart in different modules drift, and
the drift is invisible because a hit test that is subtly wrong still returns plausible answers.**

**`isPointInStroke` is asymmetric, and this is the whole difficulty.** The **path** is transformed by
the current matrix; the **point** is read in the canvas's own bitmap space, explicitly unaffected by
it. Since the backing store is sized at `width · dpr`, that bitmap space is **device pixels**, so the
matrix is rebuilt as `dpr → pan → zoom` (the draw's own order) **and** the CSS point is multiplied into
device pixels.

> **Doing one without the other is worse than doing neither.** With neither, both spaces are CSS pixels
> and the test is merely un-scaled — correct at 1×. With one, they disagree by exactly `dpr` on every
> HiDPI screen.

**The pen is widened, not the search.** The route is a third of the rail — two or three pixels at
ordinary zoom, a target no hand can hit — so it is tested at `ROUTE_HIT_TOLERANCE` (4×) its drawn
width. **Widening the pen keeps the tolerance perpendicular to the curve, which is what a player means
by "near the line"; a radius search would also catch a route running parallel a few pixels away** —
exactly the discrimination this change exists to gain.

**First hit wins.** Two routes are indistinguishable here only if they run the **same rail**, where
there is no answer to prefer — unlike `#374`'s hex test, which gave up whenever two routes merely
shared a tile.

### HexGridRenderer.tsx (route geometry) — Walk hexes, not pairs
The old loop drew each hop as two half-curves, so **one hex's two halves were produced by two different
iterations and neither knew the other's edge.** Tracing a real rail needs **both** of a hex's edges at
once — that is what identifies which authored path the train is on — so iteration is per hex.

**Non-adjacent pairs are skipped, not drawn.** A caller can hand over a partially-built route whose ends
are not yet connected (the manual builder does exactly that). **Drawing a straight line across the board
between two distant hexes would assert a connection that does not exist**; skipping shows the pieces
that *are* real and leaves the gap visible.

The ribbon is **translucent rather than opaque** so the track stays legible through it — **an opaque
ribbon would hide exactly the thing it is pointing at** — and so two routes sharing a hex show their
overlap instead of the later one simply winning.

**The city-mask clip is not applied to the hit geometry.** It punches holes so the ribbon does not paint
over tokens — a **painting** concern. **A route still runs through the city it stops at, and a player
hovering the middle of a station means that route.**

---

## Station markers and token docking

### HexGridRenderer.tsx #133 — A multi-slot city is a pill
Real 18xx cardboard draws a city that can hold N tokens as an elongated oval, N circles wide, **not as
a bigger circle**. That shape is **load-bearing information: it is the only thing on the tile that
tells a player a second company can still build into this city.** A 2-slot city drawn as a plain
circle **reads as "full", and misleads the player about a decision they are actively making.**

Geometry is two half-circles of the **same** `size · 0.22` radius `drawStationCircle` uses, joined by
straight sides. **Consecutive `ctx.arc` calls inside one path auto-connect with an implicit `lineTo`,
so the sides come for free** and the outline is a single closed path — which matters, because it means
one `fill()` and one `stroke()` **with no seam where the two ends meet.**

**Spacing is `1.6 · r`, not the `2 · r` of exactly-tangent circles:** real cardboard overlaps its slot
circles slightly, and at a full `2 · r` the pill on #63 (six radial spokes) **grows long enough to
reach its own track arms.**

**The slot rings are what make the pill countable:** the outline alone says "this city is bigger", the
rings say "it holds exactly two". Drawn at roughly **half** the capsule's stroke weight and never
filled, so they read as an internal division of one station rather than two stations that happen to
touch — **the distinction matters most on #62, where two genuinely separate 2-slot cities sit on one
tile and must not be confusable with one 4-slot city.**

`angleDeg` is the long axis in **board** space; the caller has already folded in the tile's
orientation, because markers are drawn outside the artwork's rotated transform — **without it a rotated
tile would keep a stubbornly horizontal pill sitting across its own track.**

### HexGridRenderer.tsx #134 — Per-slot token placement
A 2-slot city draws one ring per slot, **so a token has to land ON a ring rather than at the pill's
centre** — two tokens at the centre stack and hide a real, decision-relevant fact: whether that city
still has room.

**The chain records which CITY a token is in, but not which SLOT, because a slot has no meaning in the
rules** — capacity is a count and two tokens in one city are interchangeable. So slot order is chosen
client-side, by **ascending `company_id`**: deterministic and identical on every client and every
re-render, **which is the property that actually matters** — it just is not authoritative about which
physical circle a company "owns", **and nothing downstream should read it as though it were.**

### HexGridRenderer.tsx #251 — A pill has slots; dock into one
**Reported:** a token on a double-station pill snaps to the exact centre.

**The slot machinery was always right. What gated it was `chainCity !== undefined`** — which is
`undefined` whenever the chain omits `station_tokens`, as the sandbox does and any pre-G-12 contract
does. So **every** token on **every** laid tile fell through to the per-hex anchor.

**The original caution behind that gate is real and is preserved:** on a genuinely two-city tile a guess
about **which** city would draw a token in the wrong station, which is worse than drawing it centrally.
**But that risk does not exist on a one-city tile** — its index is 0 and there is nothing to guess. So
**the inference is made only where it is not a guess.**

A bucket longer than the city has slots means the chain and this mirror disagree about capacity;
**clamping to the last real slot keeps the token visible and stacked rather than vanishing, which is the
more debuggable failure.**

### HexGridRenderer.tsx #151 / #487 — Docking radius and ring width
**`#151`:** `drawStationTokenMarker` hardcoded `size · 0.22` where `size` is the **hex** size. On a
multi-marker tile the slot rings draw at `size · 0.85 · 0.22`, **so the token came out ~18% wider than
the circle it was supposedly sitting in** — overflowing the pill on every OO tile and on New York,
**which is precisely the "centering across the entire pill" symptom rather than docking.** The position
was already right; only the size was not.

A token filled to exactly the ring radius **covers the ring** — and since the token carries its own
outline **centred on** its radius, half spilling outward, filling to the ring would paint over it
entirely. `0.84` leaves the outline room to land just inside, **so the ring survives as a thin collar:
what a wooden token sitting in a printed circle actually looks like.**

**`#487`:** the ring width was `max(2, size · 0.05)` — **one absolute width for tokens drawn at three
different radii**, so a docked token wore a collar half again as heavy as a preprinted one and stopped
looking like the same piece. Now `radius · RATIO`, reproducing the old width exactly at the legacy
radius. **The floor drops from 2 to 1 and has to: a 2px floor is the same bug in miniature**,
reasserting an absolute width the moment a token is small enough for it to matter.

`PILL_SLOT_SPACING`, `PILL_SLOT_RING_RATIO` and the multi-marker shrink are all **extracted constants
shared between the function that draws and the function that places** — **if these ever read different
numbers, tokens drift off their own rings, which is exactly the class of bug this file exists to
stop.**

### HexGridRenderer.tsx #52 / #56 / #58 / #73 / #77 — The two-node coordinate, five passes
**`#52`:** `twoCityStationPoints` is shared by both the per-city track curve and the station-circle
placement, **so a laid tile's track and circles can never drift apart.**

**`#56` — the node-index inversion.** `#55`'s rewrite anchored on `landmarkSegments[1]` — the
**second/SW** segment — **unconditionally**, putting New York's home token on the Bottom-Left circle
instead of its canonical Top-Right one. The canonical rule for every 2-station archetype:
**Node 0 = Top-Right/NE = `center + offset`; Node 1 = Bottom-Left/SW = `center − offset`.**
`NewYorkHub` also had its own **stale, non-diagonal side-by-side formula**, left over from before the
layout engine; it merges into the same branch as `DoubleCityHub`.

**`#58` generalises the fix so it cannot recur.** One function, `twoNodePositions(center, size)`,
returning `[node0, node1]` — **every call site indexes into the tuple by its own already-existing
city/segment index, rather than re-deriving `±` arithmetic locally.** Purely coordinate plumbing: no
dispatch condition changed.

**`#73` replaces the offset wholesale.** A real 18xx.games reference screenshot showed the nodes sitting
at roughly a hex **vertex** — `#55`'s `(+0.43, −0.25)` resolves to **−30.17°, just 0.17° off
`cornerAngleRad(1)`** — when the real board puts each node on an **edge midpoint**. Edges 1 and 4 are
exactly opposite (180° apart), **so `twoNodePositions`' `±` structure needed no change at all — only
the vector did.**

**Magnitude:** the true edge-1 midpoint sits at the full apothem (`≈0.866 · size`); placing a
`0.22`-radius circle there would let roughly `0.22 · size` of it bleed through the printed border.
**`#77` pulls it in further, `0.58 → 0.50`:** at `0.58` the clearance was `0.866 − 0.58 − 0.22 =
0.066 · size`, so **the short real track stub connecting the edge to the station — the very thing this
offset exists to keep visible — was nearly invisible.** At `0.50` the clearance is `0.146 · size`, over
double.

**Board-wide by construction:** every double-node hex calls this one function, **and there is no per-hex
override anywhere in the file.**

### HexGridRenderer.tsx #221 — The preprinted station moved; the token did not
**Reported:** station tokens and reservation markers have "drifted" off the station nodes.

**A regression from `#210`/`#211`, and the drift is exact rather than approximate.** Preprinted hexes
used to draw their city circle at the hex **centre** unconditionally, because the track was built as two
half-segments meeting there. Now that they render from authored artwork, **each city sits where the
cardboard prints it — on its own curve's apex.** Cleveland's circle is half a hex radius south of
centre, Boston's east, Baltimore's south-east.

**The artwork moved and this function did not**, so it went on returning `center` and every token landed
on empty tile fill beside its own circle. The same `return center` fed the muted reservation markers,
**which is why both drifted together.**

The fix is `#133`'s, one layer over: **read the position off the artwork instead of restating a guess
about it.**

### HexGridRenderer.tsx #459 — Which of the two preprinted circles
The unlaid preprinted-OO branch **hardcoded index 1**, the bottom-left circle, **because before
`station_tokens` carried a city index there was nothing else it could do.** There is now, and leaving
the hardcode meant a token placed in the north-east city was drawn in the south-west one.

**`undefined` keeps the old behaviour, deliberately:** a pre-G-12 chain reports no city index, and
bottom-left is where those tokens have always been drawn — **changing it for them would move existing
tokens on boards this cannot ask about.**

### HexGridRenderer.tsx #584 — Ask the marker where the home slot is
**Reported:** on New York both city circles glowed during the NNH's home placement, and only the
top-right one is legal — followed by the observation that settles it: *"you have preprinted NNH's home
reservation marker on the correct slot — can you not check it against that?"*

**Yes, and that is a better fix than the one about to be written.** The alternative was a new table of
home city indices per corporation, **which would have been a second statement of a fact
`stationMarkerPoint` already decides — and this codebase's recurring bug is exactly that (`#559`,
`#576`, `#580`).**

**So it derives the index from the point.** Whatever `stationMarkerPoint` chooses, the **nearest** city
node to it is the slot the token will occupy. **The glow cannot disagree with the marker, because it is
reading the marker's own answer.**

**Nearest rather than an index handed across, deliberately:** the two functions compute in the same
space **by different routes** (artwork offsets against slot-point averages), so they can land a pixel or
two apart on the same circle. **"Closest" is robust to that; equality would not be.**

### HexGridRenderer.tsx #46 / #48 / #116 / #513 / #564 — Token typography and livery
**`#46` — crisp token typography.** `#45`'s `lineWidth = 2` halo was **thick enough to fill in tight
letterform counters** (the "B"s in B&O/B&M, the "O" in B&O/CPR, the "&" itself) at this badge's small
radius — a real regression introduced while fixing a different real bug. Thinned to `0.5` and recoloured
to the **opposite** of the badge's own computed text colour, **so a black halo behind black text does
not do nothing.**

Text colour is whichever of pure white/black **actually contrasts better** against that specific fill,
via `bestContrastTextColor`'s real WCAG relative-luminance formula.

> **Honest limitation, flagged rather than claimed away:** the request asked for WCAG **AAA**. Checked
> rather than asserted — only three of the eight brand colours reach 7:1 against either pure colour
> (B&O ~7.3:1 black, C&O ~7.4:1 black, B&M ~9.3:1 white). The other five's best available choice falls
> short: PRR ~5.4:1, CPR ~5.9:1, ERIE ~6.4:1, NNH ~6.0:1, **NYC tightest at ~4.9:1** — all clear of the
> 4.5:1 AA threshold, genuinely short of AAA. **That is a property of the brand palette, not a bug in
> the colour picker**, and reaching AAA would de-sync it from `StockMarketRenderer`'s copy.

The 9px font floor is passed as **that call site's own `minFontSizePx`**, not by changing `fitFontSize`
— seven other call sites share that helper with independently-tuned minimums as low as 5px, **and a
shared global floor would silently override every one of them.**

**`#48`:** the reserved badge's dashed near-white ring carried **no information a player could act on**.
Replaced with a solid ring in the **same brand colour that badge will fill with once floated**, so a
reserved badge previews its eventual colour at a glance. **Fixed at 1.75px rather than `hexSize`-scaled,
deliberately:** a thin constant ring reads as clean at every zoom, where a scaled one **would balloon
into a heavy band at high zoom, working against the "eliminate noise" goal.**

**`#116` reverses `#46`/`#48`'s solid navy treatment** — the reserved badge now fills neutral mid-gray
**and** draws at `globalAlpha = 0.45`. *"Grayed out, or transparent, or something similar"* was read as
**combine both**, since **gray alone can still look like a solid, present token.** The ring keeps
previewing the brand colour, just faded with everything else. Floated badges are completely untouched.

**`#513` → `#564` — a disc is not a box.** `fitFontSize` **floors** at `minFontSizePx` and returns that
size **even when it does not fit** (its loop exits and the floor is returned unmeasured). `#513` fixed
ERIE by narrowing the allowance for tickers longer than three characters and **left the common case on
a flat `radius · 1.7` — 85% of the DIAMETER.** That ratio is the bug.

> **Text in a circle does not get the diameter.** The widest chord is through the centre, and a glyph
> occupies **height** either side of it — so the width actually available is the chord at the top of the
> letterforms: **`2·√(r² − (h/2)²)`, not `2r`.** At the ordinary radius with a 9px bold face that is
> about **15.5px against the 15.7px the old ratio handed out**: over by a hair, every time, on every
> three-letter ticker.

**The ring is inside the budget too** — it is stroked **on** the circle, so half eats into the interior,
**and it is drawn in the corporation's own colour, which is why the symptom reads as "blending with the
border" as often as "clipped".**

**It iterates, because the constraint is circular:** available width depends on glyph height, which
depends on font size, which is what we are solving for. **`#564` also removed `#513`'s `longTicker`
special case** — ERIE and NNH are no longer exceptions to a rule, just longer strings hitting the same
chord sooner, **which is what `#513` said it wanted ("scaled, not special-cased") and could not achieve
with one ratio.**

### HexGridRenderer.tsx #59 / #60 / #61 — The town dit, three sizes
`#59` made `drawDitMarker` a **plain solid `#000000` dot with no stroke and no station-container
styling** — a small town sits on the track as a simple mark, never a buildable station hub. Radius
`0.08` → `#60`'s `0.112` (+40%) → `#61`'s `0.14`, **the same magnitude it used before `#59`'s rewrite**,
just without that version's fill and ring. ~64% of `drawStationCircle`'s `0.22`, **still visibly smaller
so towns stay distinct at a glance.** Radius-only changes: every call site's own point/size arguments
are untouched.

---

## Badges

### HexGridRenderer.tsx #62 → #66 — Shape-based iconography, and five sizing passes
**`#62`:** every revenue badge takes one uniform **solid white fill + `#1E293B` navy stroke**, carrying
the city-vs-town distinction that colour used to encode **via shape** instead. The board's full
iconography becomes: **white circles = city stations, small black dots = towns, white squares =
city/off-board revenue, white diamonds = town revenue.**

The square's half-side is `radius · √½` — **sized so its own farthest corner sits at exactly `radius`
from centre, the same maximum reach as the circle it replaces**, so none of the corner-placement or
bleed-safety math needed to change.

**`#63` inverts the sizing relationship.** Previously a **fixed radius** with the **font** shrunk (as
low as 5px) to fit — fine for a single-colour pill, but on the new white shapes a long value crowded its
own edge. Now a **bold font is fixed first** and the shape is sized around the **measured** text via
`badgeRadiusForLabel` — the same "measure text, size the box around it" approach
`drawLabelWithBackground` already uses.

**`#64` tightens two compounding causes:** the radius **floor** was still the old fixed-badge-era value,
**silently dominating the text-fit calculation for every ordinary 2-digit value and defeating the whole
point**; and padding was a generous 4/3, tightened to the file's own 2/1.5 convention.

**`#65` is structural, not a tunable constant.** A **diamond** needs radius `halfWidth + halfHeight` to
clear a text corner, because its boundary tapers away from centre on every side; **a square only needs
`max(halfWidth, halfHeight)/√½`.** **A diamond is inherently the larger shape for the same text — no
amount of padding tuning fixes that.** Every terrain maps to `"square"`; `"diamond"` stays a valid
option, unused.

**`#66` drops the `$` prefix** — the white square already unambiguously reads as a revenue badge, so the
symbol was redundant and **dropping it leaves more of the tightly-fit square for the digits.**

### HexGridRenderer.tsx #39 / #70 / #109 — Adaptive placement, and the offset that moved four times
`drawValueBadge`'s original single fixed upper-right corner **routinely collided with the city-name
labels that had moved into that same area** — worst on New York, where the upper-right corner is also
exactly where its printed NE stub runs, **stacking the badge on the track, the station circle and the
name all at once.**

**Four tiers, most-preferred first:**

1. No guard-edge overlap with live track **and** at least one guard edge is a **permanently dead** edge
   — both no current collision risk **and** a structural guarantee no future track can ever appear.
2. At least one guard edge is dead, **even if the other currently has live track** — reported from
   Baltimore, whose real edge-0/edge-4 through-route blocks **both** lower corners under tier 3, forcing
   the badge into the name-colliding upper area, **even though edge 5 points off the board's footprint
   entirely and can never carry track from either side.**
3. Simply no overlap with live track — the original tier, unchanged for the majority of the board.
4. Nothing matched — the first candidate anyway.

**`deadEdgesAt`** is the key idea: an edge whose neighbouring coordinate is not a real board hex **can
never carry live track from either side, for any tile, ever** — a strictly stronger, permanent guarantee
than "not currently live".

**The offset magnitude has moved four times**: `0.44` → `0.38` (`#107`, reported as no perceptible
difference) → `0.55` (`#108`) → `0.65` (`#109`). Each re-checked against **both** boundary shapes: a
corner slot's boundary is the full `size`, an edge slot's is the **apothem** `0.866 · size`.

> **`#109`'s honest margin check, flagged rather than silently accepted:** at a corner slot, `0.65` plus
> the documented worst-case badge radius (`0.16`) reaches `0.81` — still `0.19` clear. At an **edge**
> slot that same reach leaves only **`0.056`** of clearance, a real narrowing from `#108`'s `0.156`. A
> wide value at an edge slot could start to look crowded, **though it does not mathematically cross the
> boundary at today's badge sizing.**

### HexGridRenderer.tsx #47 / #49 / #69 / #125 — The restriction badge
`#47` added "B"/"NY"/"OO" badges at a **fixed** corner rather than an adaptive search, since the three
restricted kinds' printed track is known and fixed and one consistent corner gives players **one
predictable place to look**. Placed at the true corner (`apothem · 0.85`) rather than the badge
mid-radius zone, because Boston and New York **also** carry a real value badge whose own search can
resolve to upper-left too.

`#49` reverses two of `#47`'s decisions and **leaves them in place for history**: styling becomes plain
crisp `#000000` with **no box** (real 1830 restriction lettering is plain ink on the tile face), and the
`!hexHasLaidTile` gate is **removed outright**, so the labels persist across every tier — **the opposite
of `#47`'s "before tiles are laid" framing.** Baltimore gains a "B" alongside Boston (real 1830 prints
it on both).

`#55` then added a shield box and `#69` **removes it again**, for the reason `#49` gave: the box made
the badge read as sitting on a separate plate rather than printed on the tile. `#125` aligns the offset
to a flat `size · 0.65`, **the same magnitude and the same measurement as the revenue and compound
badges**, so a restriction badge on a slot another badge could claim lands at the identical radius.

**Badge text is genuine per-hex data read structurally** — `archetypeForHex` decides "NY" vs "B", not a
name comparison — **so a DoubleCity landmark always gets "NY" and a SingleCity landmark always gets "B",
by construction.**

### HexGridRenderer.tsx #486 — The same argument applies to the tile-level label
**Reported:** upgrading an OO tile from yellow to green puts **two** "OO" markers on the tile.

The paragraph this replaced read: *"the restriction label is NOT gated the same way —
`drawRestrictionBadge` labels the HEX, whereas this labels the TILE, which is a different statement: it
tells you what the piece in your hand is restricted to."*

**Every clause of that is true, and the conclusion still does not follow.** The two statements differ
**where the tile and the hex can differ — in the tray**, where a piece sits on no hex at all. **On the
board they cannot differ, because 1830 only permits an OO tile to be laid on an OO hex: that is what the
restriction restricts.**

The result was two "OO"s a slot apart, **close enough to read as a rendering fault rather than as two
different claims** — and it fires for all ten restricted tiles, not just OO; only OO was reported
because its upgrade is the one players perform most.

Gated exactly like `showRevenue`, **and for exactly the reason `showRevenue` is**: the board has a
placement-aware pass that owns this mark, and a second unaware one stamps a duplicate. **Default `true`,
so the tray keeps the label it genuinely needs.**

### HexGridRenderer.tsx #126 / #127 / #129 — One implementation of what a value looks like
`drawValueBadgeAt` and `drawRestrictionBadgeAt` were extracted **verbatim** because **the tile picker had
grown its own renderers and they did not match** — a bespoke white disc with its own font and stroke,
and a white rounded pill where the board draws plain black text on nothing. **Two labels in one window,
styled as different objects.**

**What stayed behind is PLACEMENT, not art:** the 13-slot search, dead-edge avoidance and per-hex
overrides all need a board position and a live `mapGrid`, **none of which an isolated tray thumbnail
has. The caller decides WHERE; this decides WHAT.**

**`#127`:** the label is **derived from terrain rather than stored as a new catalog column**, because
here the two are the same fact — `hexmap.rs` defines those terrains **precisely as** "the artwork legal
only at the B / NY / OO hexes". **A `label` column would be a second copy free to drift.**

> **Note on the tiles named in the request:** #57, #63 and #45 do **not** carry a label — #57 is the
> ordinary yellow city, #63 the ordinary brown city, #45 an ordinary brown plain. **Labelling them would
> tell the player something untrue about where they may be laid.** The **ten** that are restricted:
> #53/#61 (B), #54/#62 (NY), #59/#64–#68 (OO).
>
> *(That count read "nine" until `#486`'s harness counted the list rather than the prose: 2 + 2 + 6.
> **The enumeration was right the whole time and only the number in front of it was wrong**, which is
> why it survived — nobody reading for *which* tiles had reason to re-add them. A test now pins it.)*

### HexGridRenderer.tsx #135 — The revenue precedence chain
Most authoritative first:

1. **`revenueOverride`** — the chain's own `MapTileEntry.revenue` for a tile actually laid. Only the
   board pass has one.
2. **`entry.revenue`** — this file's mirror of the catalog's printed figure. **This is what the picker
   and offline mode resolve to**, since a tray thumbnail has no chain record and offline has no chain.
3. **`terrainBaseValue`** — the flat bucket, now a genuine last resort, reached only by plain connector
   track (which correctly buckets to `0` and draws no badge) or a missing id.

> **`??` throughout, deliberately, never `||`.** A revenue of `0` is a legitimate answer at every level
> and **must beat the level below it**; `||` treats it as absent and falls through to exactly the wrong
> number this chain exists to stop printing.

`#135` mirrors all twenty-two tiles with a printed value even though twelve agree with their bucket,
**because "agrees with the bucket" is a coincidence of today's numbers, not a property.**

### HexGridRenderer.tsx #68 / #87 → #102 — The terrain compound badge
**`#68`:** terrain cost boxes recoloured **solid red `#E53E3E` with white text** (reusing the file's
established crisp red from the impassable-border bar rather than a new hex value), so a cost reads as
visually distinct from the white revenue squares. **Already a different shape, now also a different
colour.**

**`#87`:** a **complex** hex — one with a city/town archetype **or** real live track — no longer draws a
standalone Layer-1 icon at all. **`isComplexHex` replaced the old `isDoubleCityHex` check, which missed
the SingleCity `cityDesignation` River hexes** (Toledo, Providence, Washington) — those rendered a
**full-size, dead-centred** icon directly under their own badge and nameplate. The compound badge claims
**exactly one slot**, replacing the old two-claim split.

**`#88`:** the icon moved from **inside** the red box to **perched above** it, in its ordinary terrain
colour (no longer on red, so no white override needed), laid out as one vertically stacked block centred
on the badge's single claimed slot.

**`#89`:** the icon is sized so its **rendered width exactly equals the box's width**, replacing "shrink
to the cost text's cap-height", which left the icon's width essentially unrelated to the box.
`TERRAIN_ICON_SIZE_RATIO` records each icon's width-per-`size` and height-per-`size`, **derived directly
from the drawing functions' own geometry** (both scale linearly, so one fixed ratio suffices).

**Font and padding history:** `10` → `9` (`#68`) → `8` (`#92`, layered on `#91`'s tightened padding) →
`9` (`#95`, once `#94` dropped the `$` and freed horizontal room) → `10` (`#99`). `#91`'s padding was
then **reverted** by `#97`, keeping the font drop as the sizing fix instead. `#93` widened the icon/box
gap `1.5 → 3` because the pieces read as touching. `#121` scales the **inputs** (font, padding, gap) by
35% rather than the computed `boxWidth`/`iconSize`, **letting the existing math do the rest** — a smaller
font yields smaller metrics yields a smaller box yields (via the ratio) a smaller icon, automatically.

### HexGridRenderer.tsx #86 → #100 — The water icon, seven passes and one misread
A genuinely tangled sequence, recorded because **the misread is instructive**:

| Note | Change |
|---|---|
| `#86` | one thicker S-curve → **two thin stacked strands**; stroke width −75% |
| `#88` | width +25% back; strands `0.09 → 0.16` apart; reshaped to a **tilde wave**, three alternating crests, the standard nautical glyph |
| `#90` | a third crest (5 segments) within the same span |
| `#95` | amplitude `0.16 → 0.24` — `#90`'s third crest was **mathematically present but too subtle to read**, since **each crest's visual excursion is only HALF its control-point amplitude** (a quadratic Bezier's midpoint value is `0.5 ·` the control offset) |
| `#96` | 5 → **6 segments** (three full cycles), chasing "still only two waves" |
| `#98` | **"a third wave" meant a third PARALLEL STRAND, not a third crest.** `#90`/`#96` both approached the wrong problem and are reverted; three stacked strands instead |
| `#100` | third strand removed, back to two; `strandOffset` widened `0.16 → 0.20` |

**`TERRAIN_ICON_SIZE_RATIO` tracked every one of these**, since the compound badge sizes the icon to an
exact target width: River height ratio moved `0.224 → 0.28 → 0.392 → 0.308` as the strand count and
spacing changed. **Width is unaffected throughout — amplitude and strand count do not change `halfW`.**

`#101`/`#102` enlarged the mountain icon `0.7 → 0.875` (+25%) → `1.1375` (+30%, net 1.625×). **Every
other dimension derives from `iconSize`, so one change scales the whole icon uniformly**, and the ratio
table was updated to match by simple multiplication.

---

## The 13-slot perimeter engine

> The single largest piece of `hexGeometry.ts`, and **every override mechanism in it exists because a
> real label collided with something on a real hex.**

### HexGridRenderer.tsx #70 — Thirteen slots
One coordinate system every label/badge placement resolves through, replacing each pass's own hand-
derived math (the old `BADGE_CORNERS` search, the fixed literal corner in `drawRestrictionBadge`, the
fixed lower-third terrain offset, the fixed upper-left nameplate anchor):

- **Slot 0** — hex centre.
- **Slots 1–6** — the six **edge midpoints**, clockwise from Top-Right: TR, Right, BR, BL, Left, TL.
  ("Right"/"Left" are the two **vertical** edges — these hexes are pointy-topped.)
- **Slots 7–12** — the six **corner vertices**, clockwise from the Top Point: Top, UR, LR, Bottom, LL,
  UL.

Requirement 1 (confirm the pointy-topped baseline) **needed no code change** — hand-verified that
`pointOnCircle`/`edgeAngleRad`/`cornerAngleRad` already produce a vertex at true top/bottom and vertical
edges left/right.

`EDGE_SLOT_TO_EDGE_INDEX`/`CORNER_SLOT_TO_CORNER_INDEX` are fixed permutation tables onto the file's
pre-existing conventions, **verified by hand against every one of `BADGE_CORNERS`' four existing
`guardEdges` entries before that table was replaced** (`LL → [3,4]`, `LR → [5,0]`, `UL → [2,3]`,
`UR → [1,0]`, all reproduced exactly by `(cornerIndex + 5) % 6, cornerIndex`).

**Scope:** this positions **labels and badges only**. It does **not** touch station/token node
coordinates — those keep their own independently-tuned formulas.

**Honest gap, flagged rather than worked around:** Requirement 4 also asks to anchor "Tile IDs" clear of
track. **This board does not render a tile catalog ID anywhere on a laid hex**; the terrain-cost label is
the closest existing element to that description and was refactored against it instead.

### HexGridRenderer.tsx #70 (blocking) — What makes a slot unusable
An **edge** slot is unusable if that exact edge carries live track; a **corner** slot if **either** of
its two guard edges does — **because a curve between adjacent live edges bows toward the corner between
them.**

**Centre is a special case computed by the caller, not a pure function of an edge set:** slot 0 is
occupied by a SingleCity/SingleTown archetype's always-central station circle, **or** by ordinary track
passing through it — **any hex with live edges that is *not* DoubleCity/DoubleTown**, because those two
archetypes route their track to their own off-centre nodes by construction. **Which is exactly why every
OO/G19/double-town nameplate already renders dead-centre.**

`liveEdgesForHex` reads whichever real source applies — a laid tile's rotated mask, a `GRAY_HEXES` or
`OFFBOARD_TRACKS` entry, or a landmark's segments flattened — **mirroring `archetypeForHex`'s exact
fallback order so the two always agree on which hex they are describing.**

### HexGridRenderer.tsx #72 — Cross-pass slot claiming
**Reported:** on New York the revenue badge, terrain-cost label and terrain icon all rendered stacked at
the same corner.

**Every pass called `pickHexSlot` independently, blind to what any other pass had already drawn on the
same hex** — harmless as long as no two passes' preference lists favoured the same slot, **but G19's two
stub edges block four of its six corners, leaving only two open, and three passes all picked the same
one.**

One `Map<"q,r", Set<slot>>` ledger, created fresh per render and threaded through every pass in draw
order. Each call unions its hex's claimed slots into `blockedSlots` before picking, then **records its
own pick so the next pass avoids it.** `extendSlotPreference` gives a pass whose short list is entirely
taken somewhere else to look, **rather than falling through to "first candidate anyway" and landing back
on live track.**

**The common case is completely unaffected** — the ledger starts empty for every hex, and only a
genuinely crowded landmark hex ever reaches a fallback.

### HexGridRenderer.tsx #74 — Nameplates join the ledger
**Reported (Baltimore):** nameplate, "B" badge and revenue badge all overlapping — `#72`'s ledger did not
fix every collision.

**Root cause: `singleNodeNameplateAnchor` was never migrated off the raw `pickHexSlot` call**, so it
stayed invisible to every other pass's claims. Both it and the restriction badge independently resolved
to the **same** upper-left corner — the one corner Baltimore's track leaves open. **`claimHexSlot` alone
cannot prevent that when one of the competing passes never calls it.**

**Separately:** Fall River and Atlantic City had nameplates landing on a spline **despite not being
"blocked" by the letter of the rule**, because the old preference order tried all six **edge** slots —
each sitting where a spline actually runs — before ever reaching the bottom vertex, **a perfectly good
corner it treated as almost a last resort.** Reordered to try slot 10 **second**.

### HexGridRenderer.tsx #76 — Far-side fallback
**Reported (G19), still, after `#72`/`#74`:** three elements at three **mathematically distinct** slots
that still read as visually stacked.

**Root cause one level deeper:** G19's two stub edges leave only two open corners and four open edges, so
once the icon and cost label claim two, the revenue badge's four corner preferences are **all** blocked
or claimed and it falls through to the neutral ascending fallback — **which handed back slot 2 (0°),
immediately adjacent to the icon/cost pair at 30°/60° it was trying to avoid. Distinct slots, but not
distinct enough for four real UI elements' visual footprint at that radius.**

The two **far-side** edge slots (6/NW, 5/W — 180°/240°, the opposite side of the hex) are listed as an
explicit early fallback ahead of the neutral tail.

### HexGridRenderer.tsx #104 — Minimum 120° angular separation
Every perimeter slot sits at a fixed **30° increment** (edges at 0/60/…/300, corners at 30/90/…/330),
hand-derived and verified against all twelve. `angularConflictSlots` flags any slot within **120°** of an
already-claimed slot on the same hex.

Worked example, reproduced exactly: claiming **slot 10** (Bottom Point, 90°) flags **slot 9** (30°, only
60° away) and **slot 11** (150°, 60° away), but leaves **slot 7** (270°, exactly opposite), **slot 1**
(300°, 150° away) and **slot 0** (centre, no angle) clear.

Folded into `pickHexSlot`'s existing tier search as an **extra soft-avoid layer tried first**. **If no
candidate can satisfy both real-collision-avoidance and angular separation at once, it degrades to the
original 4-tier search, ignoring angular spacing** — a genuinely packed hex still gets a real,
collision-avoiding slot rather than none, **and angular crowding there is the lesser evil.**

**Verification, hand-traced rather than assumed:** G19 is **unchanged** by this pass — its four claims
already consume every angularly-compatible option, so the graceful degrade reproduces the exact pre-`#104`
result. **Atlantic City is the genuine improvement:** its nameplate (slot 10) and revenue badge previously
landed only 60° apart at slot 9; the badge now lands at slot 8, **exactly 120° from the nameplate.**

### HexGridRenderer.tsx #105 — Preferences tuned, claim order fixed
- **Nameplates** now lead with **centre (0)**, then **top vertex (7)**, then **bottom vertex (10)** — was
  upper-left first. **Centre is blocked on nearly every real hex, so this is a practical no-op
  fallthrough to the top vertex except on a genuinely blank, trackless named hex, where it now correctly
  centres the nameplate.**
- **Compound terrain badge** leads with the two lower corners (9, 11) before the original SE-edge/bottom
  pair.
- **Restriction badges** are **unified** to one list (UL then UR, then **every edge midpoint**) —
  reachable for the first time because `drawRestrictionBadge` no longer restricts its fallback pool to
  corners, and its `badgeCenter` math is generalised from the corner-only formula to `hexSlotDirection`,
  which already resolves either. **The old archetype-driven split is retired: now that nameplates lead
  with centre/top/bottom, it no longer serves the collision it was built to avoid.**
- **Claim/draw order** is physically reordered to **nameplate → terrain → revenue → restriction**.
  **Verified via a line-count-preserving block move** (extract each pass by line range, reassemble,
  splice back) rather than freehand retyping, specifically to rule out content loss across a ~670-line
  reorder. Since these are also the real draw calls, **this changes on-canvas stacking order too** — an
  accepted side effect of honouring the requested claim order through the same code path that draws.

### HexGridRenderer.tsx #106 — The primary list must be searched to exhaustion first
**Reported (D6):** a blank hex with **nothing blocking its actual first-choice preference** still rendered
its terrain badge at Edge 5 instead of the fully-open Vertex 3.

**Root cause:** `claimHexSlot` **pre-merged** the caller's curated preference list with the fallback tail
into **one combined list**, and the dead-edge tiers scanned that whole list — **so a low-priority
fallback-tail slot that merely happened to sit next to a dead edge could leapfrog a genuinely open,
actually-preferred primary slot.** D6's slot 6 sat next to its one dead edge; slot 10 did not.

Split into `pickFromCandidates`, run **once against the real list to exhaustion** and only **then**
against the tail. **The fallback tail can no longer outrank an available primary-preference slot.**

`#106` also introduced **`HEX_SLOT_OVERRIDE`** — per-hex, per-pass explicit slots for the small set of
named hexes where a request asked for a specific canonical vertex **rather than a change to the
board-wide preference order, which would ripple into every other hex sharing that pass.** Every override
was **hand-verified against the hex's actual live edges** before being added; two turned out to be
genuinely blocked by real track and **degrade to the nearest open alternative — the override is kept
anyway as accurate documentation, and the degrade is a harmless no-op, not a wrong claim.**

**`HEX_SLOT_RESERVE`** handles the one case where an **earlier** pass's graceful fallback would otherwise
claim the one slot a **later** pass has an achievable override on: it filters that slot out of every
other pass's candidates, **so the later pass is not starved by going second.**

### HexGridRenderer.tsx #111 / #112 — An explicit override needs its own resolution path
**Reported (Washington):** the nameplate rendered at Vertex 1, not the override's Vertex 0; the terrain
badge at Vertex 4, not Vertex 2.

**Hand-verified** by computing Washington's real dead edges: J14 has exactly **one**, its east
board-boundary edge, whose two guard corners are **Vertex 1 and Vertex 2 — both of the corners the
reports landed on or were displaced from.**

**Root cause:** `withSlotOverride` prepended the override onto the preference list and ran the **combined**
list through the normal tiered search — **whose tiers 1–2 favour any dead-edge-adjacent open slot over a
merely-open one, regardless of list position.** Vertex 0 (the override, genuinely open, first in the
list) is not dead-edge-adjacent, so tier 1 skipped past it. **The exact D6 bug, reproduced one level up
inside a single already-combined list.** Once the nameplate wrongly landed there, **its own angular
conflict then pushed the terrain badge off Vertex 2 onto Vertex 4 — a real, mechanically-explained
cascade, not randomness.**

Fixed with `claimHexSlotPreferring`: **try the slot directly — blocked/already-claimed check only, no
dead-edge tiering and no angular soft-avoidance, since an explicit request should win a mere tiebreak
heuristic** — falling through to the ordinary tiered search over the pass's **unmodified** list only if
the override is missing or genuinely unusable.

**`#112` is the same root cause surfacing in the plain, non-override path.** H18's "OO" badge was not at
Vertex 5 like the other three OO hexes: **H18 is the only one of the four bordering the board's edge**,
and tier 1 matched its dead-edge-adjacent Vertex 1 before ever confirming Vertex 5 was a perfectly good
answer. **Confirmed by hand that the other three are fully interior with zero dead edges**, so their tier
1 never matches and they fall straight to Vertex 5 correctly.

### HexGridRenderer.tsx #113 / #114 / #115 — Force, for "show me anyway"
**`#113`:** *"I want to see how it looks there, I don't care what it overlaps"* — **a genuinely different
ask from every prior placement request, which all wanted the safest achievable slot.** `HEX_SLOT_FORCE`
skips **every** collision check: real track, already-claimed, angular crowding. Kept as a **separate
table** rather than a flag on the override, **so the two stay semantically distinct — an override is a
real, collision-respecting decision; a force is a deliberate, temporary probe.** The claim is still
**recorded**, so other passes still steer clear.

**`#114`:** having seen it (*"I see it is a problem there"*), G19's force is removed and both badges move
to genuinely open edge slots via ordinary overrides.

**`#115`:** Boston's nameplate reaching Vertex 3 was **suspected** to be the same dead-edge leapfrog.
**Checked, not assumed: it is not** — Vertex 3's guard edges are 4 and 5, and **edge 5 IS one of Boston's
two real live edges**, so this was always a genuine track collision, correctly identified by the graceful
degrade the whole time. **Forcing through it is the correct tool here, not another bug fix.**

### HexGridRenderer.tsx #55 — The universal canvas layout engine
**The rule this enforces: no rendering code may branch on a specific hex's `label`/`name`/`(q,r)` literal
to decide *where* something is drawn — only on structural tile/terrain data that would classify
identically for any other hex with the same real properties.**

Genuine per-hex **data** — a city's name, a landmark's sourced printed edges, which artwork is legal
where — **is not itself a hack; every board game inherently has per-hex facts.** What changes is that no
**placement formula** is keyed off hex identity.

`archetypeForHex` classifies any hex into **SingleCity / DoubleCity / SingleTown / DoubleTown / Plain**
purely from structure: a laid tile's real terrain, or an unlaid hex's OO membership, town/city
designation, gray marker kind, **or a landmark's own `LANDMARK_TRACKS` segment count.** That last one
removed the file's final identity literal, `hex.label === "G19"`, replacing it with **"is this a landmark
whose own data has two independent stub segments"** — New York today, **any future same-shaped landmark
automatically tomorrow.** The restriction badge's `name === "Boston"` check went the same way.

`archetypeForTerrain` maps every `TerrainType` by **what kind of city/town it draws** — `MajorCityHub`
and `BostonHub` share "SingleCity" because both draw exactly one station node (**Boston's hub just also
carries the "B" label restriction, a legality concern unrelated to layout**); `DoubleCityHub` and
`NewYorkHub` share "DoubleCity" for the identical reason.

**Shared placement formulas:** `doubleNodeOffset` for every two-node hex with no anchoring track of its
own, `singleNodeNameplateAnchor` for every one-node hex. **New York — a DoubleCity landmark with real
printed stub track — keeps its own authentic edge-anchored station geometry** (moving a station circle
off the end of its own real rail would be a visual regression), **but its nameplate uses the shared
DoubleCity dead-centre anchor and stacking rule exactly like every other DoubleCity hex.**

### HexGridRenderer.tsx #59 (nameplate anchor) — Slot-aware, byte-identical in the common case
`#55` anchored **every** single-node hex at the identical fixed Upper-Left point regardless of what track
that hex actually has — fine for most of the board, **with no fallback at all for the hexes whose printed
track runs through that exact wedge.**

`#70` makes the choice dynamic while keeping the **same wedge magnitude** (`size · hypot(0.25, 0.35)`),
re-aimed along the chosen slot's direction. **A hex that resolves to slot 12 renders at the exact same
pixel as `#55`'s literal formula**, via an explicit special case — so the overwhelmingly common unblocked
case is pixel-identical. *(`#105` then moved Upper-Left off first place, so that property no longer
holds board-wide.)*

---

## Nameplates

### HexGridRenderer.tsx #6c / #3b — Fit the font, then give it a background
`fitFontSize` shrinks in 1px steps until `measureText` confirms the text fits — **but that alone does not
stop a legibly-sized label visually colliding with a track stroke drawn underneath it**, so
`drawLabelWithBackground` paints a small translucent rounded rect **sized to the actual measured text**
first.

`#46` changed the family to an explicit `system-ui, -apple-system, sans-serif` stack **inside
`fitFontSize` itself**, for all eight call sites at once — **safe precisely because a font-family swap,
unlike a size floor, carries no per-caller layout risk**: the shrink loop re-measures against whatever
resolves and backs off further if needed.

### HexGridRenderer.tsx #50 → #54 → #78 → #82 — The shield box, four times
| Note | Decision |
|---|---|
| `#50` | **Strip everything** — no plate, no halo, no hover shadow. Solid `#000000` on the hex's own fill. Font standardised to 10/8, hover changes **weight only** (the old 10→13 swing was "the single biggest source of wild fluctuation") |
| `#51` | **Box back**, because track splines routed beneath a nameplate cut through its letterforms. **Not a revival of the old pill:** 2.5px padding, `cornerRadiusPx: 1`, zero stroke, zero shadow, filled to ~match the hex. **The box exists purely to occlude track behind the letters, not to draw attention to itself** |
| `#53` | **Box removed again** — once `#52`'s real sparse bitmasks landed, the bands these nameplates sit in are clear of track most of the time, **so `#51` was patching the symptom at the wrong layer.** Left the helpers defined, unused, "in case a specific still-crowded hex needs a targeted box later" |
| `#54` | **That request arrived.** Box back, applied uniformly, now **tier-colour-matched** via `nameplateBoxFillFor`: yellow / mint / slate by the laid tile's real colour or the hex's printed category |
| `#78` | **Replaced by one flat semi-transparent white** for every nameplate on the board, going **fully opaque on hover** — so a track spline stays softly visible through it at rest, and **the box, not the tile colour, is what changes on hover** |
| `#82` | Alpha `0.75 → 0.55`; hover unchanged, so the rest/hover contrast is now wider |

**`nameplateBoxFillFor` and the three tier constants are left defined but unwired**, per this file's
convention of keeping a superseded constant as a documented historical record rather than a silent
deletion.

### HexGridRenderer.tsx #79 → #83 — Wrap, then don't
**`#79`:** ten named hexes rendered visibly **smaller** than every other nameplate — **`#78`'s "one
uniform size" standardisation wasn't actually uniform**, because the single-node pass still ran each name
through `fitFontSize` against a tight `hexFlatWidth · 0.55` budget: short names fit untouched, longer ones
silently shrank. Fixed by **wrapping** at the first space, and by giving a single-word name a much wider
`0.92` budget so it no longer needs to shrink either.

**`#83` reverses the wrapping.** Per explicit rule: **a nameplate wraps only when it names two separate
cities via an ampersand**, with **one** named exception — "Maritime Provinces", too long for its hex
despite naming one place. `#79`'s "any multi-word name wraps" and `#47`'s "any multi-word off-board name
wraps" are both reversed; "Canadian West" and "Deep South" render on a single line. **The width-widening
fix is unchanged.**

`drawSingleNodeNameplate` is kept as a thin, explicitly-named wrapper rather than inlined at both call
sites, **so a future single-node exception has one obvious place to go.**

### HexGridRenderer.tsx #84 — One shield for two lines
**Reported:** a two-line nameplate showed a visibly darker band where the two lines met.

`#82`'s 0.55-alpha boxes, drawn independently per line and separated by only one line-height, **composited
their alpha wherever they overlapped.** `drawStackedNameLabel` measures **both** lines, unions their padded
boxes into **one** rect and fills it **once** — no seam, regardless of the lines' relative widths.

**Both lines also render at one shared font size** — the smaller of each line's independent fit — **so a
length mismatch between the two words cannot produce a visible size mismatch either.**

`fillRoundedRect` was extracted (behaviour-identical) from `drawLabelWithBackground` so the two share one
box-building path.

### HexGridRenderer.tsx #51 (line height) — Font-relative, not zoom-relative
`NAMEPLATE_LINE_HEIGHT_PX = fontSize · 1.05` replaces the old `hexSize`-relative offsets. **A deliberate
switch:** now that the nameplate font is near-constant regardless of hex size, tying line spacing to that
same font size **keeps the two lines a constant, tight distance apart on screen at every zoom, instead of
drifting wider apart as the board is zoomed in.**

### HexGridRenderer.tsx #78c / #85 — The off-board block
The name and revenue badge were **two independently hex-relative-offset pieces** (name pinned `0.42`
above centre, badge `0.44` below, **regardless of how many name lines there were**). Rewritten as **one
combined block**: total height computed from the **actual** line count plus the badge's measured
diameter, then centred so **the block's own vertical midpoint** lands on the hex's centre — **the badge
sits immediately beneath the name rather than at a fixed offset that happened to look adjacent only for
the one-line case.** Falls back to badge-only, centred, when names are hidden. `#85` flips the order so
the **badge sits on top**.

### HexGridRenderer.tsx #41 / #49 / #54c — Stacked dual names move to centre
The four OO hexes and three double-town hexes get **two independent labels, one above the other**,
instead of one string through the centre — reported for the original side-by-side layout, where each half
was squeezed into **less than half the hex's width** and a name like "Philadelphia" visibly collided.

`#49` moved the OO pass from the upper-third band to **true hex centre**: with the two station circles on
a top-right/bottom-left diagonal, **the open space actually available is the middle of the hex, not the
top** (which the top-right circle now partly occupies). `#54c` did the same for double-towns once their
dits went diagonal.

**Each half's hover state is judged by the same shared hex coordinate** — the two stations are not
separately hoverable, only the hex as a whole is.

---

## Board data

### HexGridRenderer.tsx #122 — Tile fill is per-ERA, not per-terrain
Previously a laid tile's fill came from a table keyed on **terrain**, so tiles of the same era painted
different colours purely because of what was printed on them: a plain #9 `#f4ecd8`, a town #4 `#f0d9a0`,
the yellow city #57 `#e8d9c0`. **#57 sits on nearly every city hex on the board, so the single most-placed
tile in the game was also the most visibly off-tray.**

**Real 1830 cardboard is one stock colour per era; the artwork on top varies, the card does not.**

A second divergence went with it: the board loop **overrode** the fill to yellow for any `printedColor:
"Yellow"` hex, so an upgraded Green or Brown tile on a landmark or OO hex **kept painting yellow
forever.** Era now wins everywhere, **which is also what tells a player at a glance that a hex has
actually been upgraded.**

Gray and Red are **not** in this table on purpose: they are properties of preprinted **board** hexes, not
of layable tile stock.

### HexGridRenderer.tsx #152 → #161 — Two palette passes
**`#152`:** the old set was three desaturated pastels within a few points of each other — **Yellow
`#f0d9a0` and Brown `#d8bc9a` differ by about as much as two shades of the same beige**, which on a board
where **the tier IS the information** is the one distinction that must never be subtle. Yellow became a
real saturated yellow and Brown a real brown, **so the tiers separate on hue and lightness at once.**
Green deliberately unchanged — not part of the reported confusion, and restyling it would be an
unrequested change to a third of the board.

**`#161` specifies the canonical palette directly** rather than approximating. Green moves for the first
time, **because this is a full palette specification and the earlier narrow reasoning no longer applies.**

> **One measurement worth knowing, since it is not fixable by choosing better values:** Green and Brown
> sit at a **1.47:1 luminance ratio** and are separated almost entirely by **hue**. For a red-green
> colourblind viewer those two tiers are close to indistinguishable **by fill alone**. The tier is also
> carried by the rim colours, the tile number in the picker, and the fact that available upgrades are
> filtered to the tier — **so no decision in this app depends on telling those two fills apart by eye.**
> Recorded because it is a real property of the canonical colours.

### HexGridRenderer.tsx #153 → #161 → #473 — Track ink
**`#153`:** with `#152`'s dark Brown, near-black track measured **~1.6:1** — below the threshold at which
a thin line is visible at all. **Darkening Brown without moving the ink would have traded one confusion
(which tier is this?) for a worse one (where does the track go?).** So the ink followed the tier.

**`#161` unified it again**, because the canonical Brown `#CB7745` is a much lighter clay: 13.9:1 on
Yellow, 7.7:1 on Green, **5.2:1 on Brown** — comfortably past the 3:1 a thick graphical line needs.

> **The table stays even though all three values now agree.** It is what makes "ink is a function of the
> tier" a **structural fact rather than a coincidence**, and it is the thing that caught the problem the
> last time a fill moved. A future palette change edits one table instead of hunting `strokeStyle`
> literals through the renderer.

**`#473`:** the value was inlined three times — fine while the table was the only consumer, **and not fine
once the off-board stubs had to match it.** They were on the older `#2b2b2b` and **the seam showed exactly
where a player traces a route off the map.** Naming it makes "off-board track matches tile track" a fact
the code states rather than a coincidence of two literals agreeing.

**`#473` also added the arrowhead.** On a real board an off-board connection **tapers to a point** — the
visual statement that the route leaves the map here. **A blunt round cap says the opposite: it looks like
track that was cut off, which is how an unfinished rendering looks rather than how a terminus looks.**
Drawn as a **filled triangle on a shortened stub**, not a stroke trick — tapering a stroke would need a
variable-width path, whereas this is trivially correct at every zoom and keeps the curve the same
primitive every other track uses.

### HexGridRenderer.tsx #136 — Terrain fees are per-hex, not per-type
This was a `Record<BoardHexType, string>` keyed on the hex's **rendering category**. In real 1830 — and
in the contract since G-10 — **terrain cost is a property of the HEX**: `terrain_build_fee(q, r)` consults
`RIVER_HEXES`/`MOUNTAIN_HEXES`. Keying on a display type meant the two models could disagree about any hex
whose category and terrain membership diverged, **and it made the frontend's number look like a UI
constant rather than a mirrored contract value.**

> **The figures are the contract's, and the spec document is wrong.** `AUDIT_PART2_FRONTEND.md` records
> the spec as "$20 River / $80 Mountain". That is not real 1830 and not what this contract charges:
> `RIVER_BUILD_FEE = 80`, `MOUNTAIN_BUILD_FEE = 120`, which is also what the physical board prints. **The
> renderer already showed $80/$120; the reconciliation needed was to the SPEC, not to the code.**

Constants are named after their backend counterparts **so the correspondence is checkable by grep rather
than by memory**. Still a mirror: no query surfaces `terrain_build_fee`, so this cannot read the figure
off the chain the way tile revenue now does.

### HexGridRenderer.tsx #118 — Terrain became a real charge
Previously the fee was a **legibility label that happened to sit next to the real number.** Now
`execute_lay_tile` reads it from the hex, **paid once when a hex is first built on and free on every
later colour upgrade** — closing **both halves of the old exploit**: laying an ordinary plain tile onto a
real river or mountain hex used to be **free**, and laying the invented "mountain pass" artwork onto flat
grassland used to charge **$80 for nothing.**

`#150` is the display consequence: **once a hex carries a tile, the $80 or $120 on the badge is not what
the next lay costs — it is what the last one cost, rendered as though it were a live price.**

### HexGridRenderer.tsx #223 / #420 / #472 — The veil constants
Live in board data rather than inline in the draw pass **for the same reason every other board colour is:
a value used once today is a value copied twice tomorrow.** The ink is the board's own deep navy rather
than neutral black, **so the veil reads as the map receding rather than a grey sheet over it.**

The deletion note warned that **"a dimming constant sitting in the board palette is a standing invitation
to reintroduce a global overlay."** That risk is real and is answered where it can be: **the renderer
cannot dim without `layFocus.dim`, which only the shell sets, and only from `isMyTurn`.**

### HexGridRenderer.tsx #561 — A legality cue is not a livery
**Reported:** placing ERIE's home station, both slots glow correctly — **but it is hard to tell, because
it is yellow on yellow.**

The glow was derived from the placing corporation's colour, reasoning that the highlight should say
**whose** token is coming. **It does say that, and it says it against a board that also uses colour to
mean something:** tiles are yellow, green and brown by era. ERIE is yellow and lays on a yellow tile; the
B&O green sits on green track. **Roughly a third of the roster has a livery that collides with some tile
tier, and each collision hides the one cue the player needs at the moment they need it.**

**White**, because the question the ring answers is *"may I click here"*, which has nothing to do with
which corporation is asking — **and identity is already carried twice over** by the cursor (`#496`) and
the confirmation ring's own livery swatch (`#462`). **A third channel for identity that costs legibility
is a bad trade; the same information for free is not information.** It is also the highest-contrast ink
against all three tile tiers at once.

### HexGridRenderer.tsx #29 → #6b — The edge-reflection formula, and the identity claim that broke it
A "structural calibration" pass replaced this file's verified reflection
(`our_edge = ((4 − their_edge) % 6 + 6) % 6`) with a claimed **direct identity** mapping, citing its own
470-edge cross-check.

**Re-investigated, because the two claims directly contradict each other and this file's own discipline
is to verify rather than silently trust either.** Re-deriving New York's stubs under the identity mapping
puts one at axial `(7, 6)` — label **"G21", which does not exist** (row G stops at G19) — **the exact same
red flag `#6b` originally used to catch the ORIGINAL bug, now catching the identity claim instead.**
Montreal's identity-mapped edge lands on "A21", also absent, **literally running the track off the board's
eastern edge — matching the report's own "running sideways into the ocean" description.**

**Since reflection is its own inverse, applying the same formula to the identity pass's stored values
exactly recovers the doc-verified originals.** Applied to **all three landmarks and all twelve gray
hexes**, not just the five named by city — **reverting the other seven would leave them on the same broken
formula for no principled reason.**

### HexGridRenderer.tsx #12 (board tables) — Designations, and what they are not
`townDesignation` and `cityDesignation` mark ordinary **white, buildable, no-printed-track** hexes that
nonetheless carry a preprinted marker — verbatim-sourced from the `white:` block's `town=revenue:0` and
bare `city` entries. **Deliberately not modelled as `GRAY_HEXES`:** the source has **no `path=` data at
all** for these, so they draw a placement-guide marker and **no track.**

`GULF_HIDDEN_EDGE` / `CANADIAN_WEST_HIDDEN_EDGE` suppress the one **shared interior edge** of each
two-hex off-board zone so it reads as a single merged region, with one centred nameplate instead of two.
**Both derived from axial adjacency and cross-checked against `OFFBOARD_TRACKS`' own real-neighbour
comments**, which land on the same shared edge from both sides. The merged nameplate is deliberately
**not** wrapped in `withHexClip` — it sits **on** the shared border by design, and clipping to either one
hex would slice the text in half.

Two gray hexes (Altoona, Rochester) have a **third** real path that **bypasses their own city circle** — a
real 1830 "some trains skip this stop" rule. **Altoona's is reinstated** (asked for by name); Rochester's
is **not — flagged rather than silently matched.**

`NAMED_HEX_LABELS`' F24 is **"Fall River", deliberately not the board's real "Mansfield"** — an explicitly
requested house-rule cosmetic override, **contrasted in the same request with B16's explicitly authentic
"Ottawa"**. Unlike an earlier "River Falls" ask, **which was framed as factual and was correctly declined
because it did not match the source.** The real name is left recorded in `GRAY_HEXES`' own comment and in
`hexmap.rs` for the historical record.

### HexGridRenderer.tsx #38 — Impassable border edges
The frontend's **drawing-only** mirror of `hexmap::IMPASSABLE_HEX_EDGES`, which enforces the actual
legality. **Unlike the backend's table, which lists both hexes' edge** (since it must reject a lay from
either side), **this only needs to draw the line once**, so one side of each border is listed. Coordinates
match `STATIC_BOARD_HEXES` exactly, and the edge indices were **independently cross-checked against the
backend's identical derivation** from `HEX_NEIGHBOR_OFFSETS`.

### HexGridRenderer.tsx #242 — The display name is not the hex's identity
`describeHex` returns a **human string** — "New York (G19)" — and is right for a tooltip, a log line or a
feedback message. **It is emphatically not an identifier, and treating it as one is a bug that hides
well: the string contains the real label, so it looks correct in every message it appears in while
failing every lookup and every wire payload it is passed to.**

Exactly what happened to the manual route builder: it stored this as its waypoint label, so the pricing
table (keyed on `"G19"`) **missed on every stop and priced the whole route at $0** — while the auto-tracer,
building labels from board data, priced identical routes correctly. **The same string went into
`RunManualRoute`'s `path[].hex`, so the payload would have been rejected on chain for naming a hex that
does not exist.**

**So the two are now separate functions with names that say which is which. Anything that INDEXES,
COMPARES or TRAVELS uses the identifier.**

### HexGridRenderer.tsx (off-board is on the board) — A naming trap worth stating
`boardHexExistsAt` counts the red off-board hexes as **on** the board, and the naming is confusing enough
to be worth saying: they are "off-board" in **1830's** sense of lying outside the operating map, **but
they are real entries at real coordinates, they are drawn, and track legally runs to them — they are where
routes terminate.** What this excludes is a coordinate with **no hex at all**.

Lives in geometry rather than a route utility **because it is a question about board geometry, and both
the routing layer and the tile-legality filter ask it** — putting it in either would make the other import
across a layer boundary.

### HexGridRenderer.tsx #125 — Offline mode stopped filtering by era
`localCatalogPlacements` used to return only the tiers a room in `currentEra` had unlocked, **so a fresh
offline session showed twelve Yellow tiles and nothing else, with no way to reach the other thirty-four —
the player was stuck looking at one tray.**

**Offline mode exists to INSPECT the catalog**, and the picker now has era tabs, **so the filtering moved
there where it is a view control the player can change rather than a wall.**

**This does not weaken any rule, because it was never enforcing one.** The result carries no legality
claim of any kind — no era lock, no connectivity, no reservation, no colour step, no tray depletion —
which is why it goes out under the `"offline"` status the UI must label as provisional and must not
dispatch from. **Reimplementing `legal_tile_placements` here would create a second copy of the rules to
drift.**

All six orientations are offered, **since without the contract there is no basis for excluding any.**

### HexGridRenderer.tsx #318 / #364 — The private company reservation badge
**It is deliberately not a `drawRestrictionBadge`.** The "B"/"NY"/"OO" badges are **printed on the
cardboard** — permanent properties of the hex, part of the board's artwork. **A reservation is a temporary
game-state fact that comes and goes with a company**, so it is drawn in its own key: a gold padlock rather
than the board's black serif letters.

**The lock is drawn, not typed.** `🔒` renders as a colour emoji on some platforms, a hollow glyph on
others, and a **tofu box** where the font is missing — **and this file's whole doctrine is authored artwork
over whatever the font stack happens to supply.** Two paths are three lines of code and identical
everywhere.

**`#364`:** the first version looked like a **button**. All three reported symptoms — too large, overflows
into neighbours, reads as clickable — **came from one decision:** a filled, stroked, drop-shadowed pill,
**which is exactly the visual vocabulary of a button.** The pill also set the size: wide enough for "C&SL"
plus a lock plus padding is most of a 42px hex's width.

The plate is gone; what remains is a lock and two or three letters with a dark halo, **roughly 40% of the
former footprint. The ampersand goes too** — "CSL" and "DH" are the same identifiers minus a character
that costs width and adds nothing: **nobody reads a two-letter mark on a hex corner as a company name they
need punctuated.**

**The positions are pinned, not claimed.** Every other badge negotiates for a slot, which is right when
several passes compete for one hex. **There are exactly two of these, on two known hexes, and both were
given a specific home** — B20's at the bottom vertex, F16's on the bottom-left edge. **A negotiated slot
could have put either back over a neighbour, which is the bug.**

**Not clipped to the hex**, either: every pass above is, because printed artwork belongs inside its own
hex — **but this is a marker sitting on the board, and a pill wide enough to carry "C&SL" legibly would be
sliced by the boundary at smaller zooms. It is the only mark allowed to overhang, which is also what makes
it read as a piece.**

---

## Small but load-bearing

- **`drawHexEdges`** strokes only *some* of a hex's six borders, each as its own 2-point subpath — unlike
  `drawHexPath`'s single closed all-or-nothing path — so a caller can omit exactly one shared seam while
  drawing the other five normally.
- **`drawUnknownTilePlaceholder`** replaces a bare red `"#N?"`. That was safe (it never threw) **but
  degraded to something the player cannot act on**: the picker offers whatever the contract returns
  verbatim, **so an id this mirror has not caught up to is still a fully legal, clickable, submittable
  choice — just an unrecognisable one.** It deliberately **does not guess at track geometry**: there is no
  bitmask to decode, **and a fabricated path would be worse than an honest blank, since the player would
  have no way to tell it apart from real artwork.**
- **`ES5 iteration`**: `forEach` rather than `for…of` over a `Map`'s `.values()` — this build targets ES5
  without `--downlevelIteration`, so iterating a Map's iterator does not compile.
- **`edgeMidpointUnit` in `TileGraphics.ts`** is recomputed rather than imported, **to keep that module
  free of a dependency on the canvas geometry helpers** — the two are asserted equal by a round-trip check
  in the overlay harness.
- **`tileCitySlotCounts`** must stay equal to `hexmap::tile_city_slot_counts` — **that is the authority,
  this is the mirror.** They are separate because **the renderer needs the count before any chain
  round-trip (to draw the pill at all), while the contract needs it to enforce capacity.** A drift shows up
  as a pill with more or fewer rings than the contract will let companies fill.
- **`tileCityAnchors`** is **the single source of truth for city position on a laid tile**, and is what
  `stationMarkerPoint` must consult: a token has to sit on the same circle the artwork drew, **and the
  artwork's circle is per-tile, not the fixed diagonal `twoNodePositions` returns.**
- **`tileCitySlotPoints`** returns `[]` for an unknown tile or out-of-range index, **never a guessed
  point** — a caller that gets nothing back should fall back to the hex centre rather than render a token
  somewhere arbitrary.
- **`marginLabelReserve`** is an **estimate**, because no canvas context is available where
  `boardContentBounds` needs it. It only has to be **generous enough that the exact `measureText` pass
  never needs more room than the camera set aside.** Two-character column numbers are the widest labels
  this board ever draws, so a `1.4×` multiplier on the font size covers a bold digit pair in either
  dimension **without hardcoding an absolute pixel value disconnected from `hexSize`.** Both call sites
  derive the identical value, **or labels get clipped (camera reserves too little) or render on top of the
  outermost hex (reserves less than the corner-to-label distance).**

---

# Contract mirrors and the livery — `hexContractTypes.ts`

Phase 3a of the `HexGridRenderer.tsx` monolith extraction: the frontend's mirrors of the contract's query
response shapes, the pure helpers that read them, and the click-query state machine the renderer reports
through. Shares the rail-map `#N` namespace — anchored `HexGridRenderer.tsx #N`.

### HexGridRenderer.tsx (hexContractTypes header) — Why the types had to move first
Phase 3 extracts the hex geometry and slot engine, **and much of that engine is not pure coordinate math** —
`archetypeForHex`, `liveEdgesForHex`, `hexBlockedSlots`, `claimHexSlot*`, `hexRouteValue` and
`describeHexWithValue` all take a `MapGridResponse` or a `StationTokenCompany[]`. Those types lived in
`HexGridRenderer.tsx`, **so moving the geometry without them would have made the new module import from the
file that imports it: a cycle.**
Leaving those functions behind was the alternative and it was worse — **it would have split the slot engine
down the middle, with half its call graph in each file.** So the types move first, as their own leaf,
depending on nothing but the already-extracted tile catalog. **Import direction is one-way: never import from
`HexGridRenderer.tsx`.**

### HexGridRenderer.tsx #119 — `paths` is optional, and the optionality is not decorative
Each `[a, b]` is one continuous run of track between edges `a` and `b`; **`a === b` is a terminal spur that
enters at `a` and dead-ends.** Apply `orientation` yourself, the same as for a catalog entry's connections.
**A contract built before this field existed simply omits the key**, and the reader treats `undefined` and
`[]` identically and falls back to the local catalog mirror — **so an older chain renders exactly as it did
before rather than throwing.**

### HexGridRenderer.tsx #132 — The printed revenue, and the `Uint128` trap
The tile's printed revenue comes straight off the chain (`hexmap::tile_base_value`, Audit G-11) and is the
single authority for what a stop on this hex pays.
**Typed `string | number` because the backend field is `Uint128`, and cosmwasm-std serialises `Uint128` as a
JSON *string* — it has to, since a `u128` overflows an IEEE-754 double past 2⁵³.** Reading it and expecting
arithmetic to work is the trap; **one parser, in one place.** `number` is accepted too so a hand-built fixture
needs no change.
**`undefined` and `0` are DIFFERENT answers and callers must not conflate them:** `0` is a real figure (plain
connector track earns nothing, and the badge should be suppressed), `undefined` means "this chain never told
us" and the caller falls back to the terrain bucket rather than printing `NaN` or `$0`.
**Not to be re-derived from `terrain`.** That is what this replaces, **and it was wrong for most city tiles:**
the terrain lookup is a flat per-bucket value, but real 1830 prints revenue on the TILE — #62 and #64 are both
two-city brown artwork and print different figures, and the whole Green/Brown city ladder collapsed to one
bucket value under the old model.

### HexGridRenderer.tsx #134 / #560 — A hex is not a city
`station_token_hexes` is `(q, r)` and **cannot express which of a two-city hex holds a token.** New York
(#54/#62) and every OO tile (#59, #64–#68) carry two cities on one hex, **so the renderer fell back to a
heuristic — and the heuristic picks the first slot, which is the bottom-left one, every time, for every
corporation.** (`#560`, reported: placing ERIE's home station, the player clicked the top-right city and the
token landed on the bottom-left.)
`station_tokens` is the same tokens as `(q, r, city_index)`, mirroring Audit G-12. **The renderer has PREFERRED
it since `#134`; nothing on the frontend side ever wrote it, so the preference never had anything to prefer.**
**Three states stay distinguishable:** absent means "this chain predates G-12, fall back to the heuristic"; an
entry means "this slot, definitively"; **an empty array alongside a non-empty `station_token_hexes` means "this
chain doesn't know", never "no tokens"** — which is why the two arrays are written together and never one
without the other. The reader returns `undefined` rather than `0` **so the caller falls back to the heuristic
rather than asserting city 0 and confidently drawing a token in the wrong station.**

### HexGridRenderer.tsx #36 / #44 / #45 — The home-hex table and the ticker fallback
A hand-kept SUBSET mirror of `PublicCompanyState` — only the fields the station-token pass needs, re-declared
locally rather than imported. The home-hex table mirrors `hexmap::CORPORATION_HOME_HEX`, **derived from this
file's own landmark/gray/OO hex entries exactly the way the backend constant's doc comment describes.**
**#44 is a deliberate departure from real 1830, requested three times explicitly by the owner of this custom
board:** NYC (company_id 2) is reassigned to Albany (E19), and NNH (company_id 7) — previously omitted for
having no assigned home — takes over the New York (G19) hex NYC vacated. Mirrors `hexmap.rs` module doc #25.
**#45 — the acronym overlay guarantee.** A small duplicated copy of `public_company.rs`'s real on-chain tickers
exists so **a RESERVED/unfloated home-station badge can always draw its acronym before `publicCompanies` has
loaded, or ever loads.** The drawing pass prefers a live `company.ticker` and falls back to this table rather
than an empty string. **Company 7's real ticker is `NNH`, not `NYNH`** — the contract constant is the single
source of truth, and "NYNH" is this project's colloquial name for the railroad. Using `NNH` here **keeps the
placeholder identical to what will actually show once the corporation floats, so the badge never visibly
flickers at that moment.**

### HexGridRenderer.tsx #234 — A near-white ring around white lettering
**Reported:** PRR and CPR tokens are very hard to read.
A placed token is a small disc of brand colour with its acronym on top, ringed in the board's cream. **Two
things go wrong at once and they compound:**

- **The ring does not separate.** A token sits inside a WHITE city circle, so a cream ring is near-white on
  near-white. **The one job of an outline is to say where the token ends, and it could not.**
- **The ring crowds the glyphs.** The disc is small and a size-scaled stroke centred on that radius eats
  inward. On the dark-filled corporations the acronym is WHITE, **so the lettering ran into a near-white band
  with only a sliver of fill between them** — three-letter tickers on the smallest discs in the game, with the
  contrast removed exactly where it was needed.

**Charcoal fixes both without touching the brand palette.** Applied to every floated token rather than only the
white-lettered ones: the light-filled corporations had the same separation problem against the white circle,
**and one ring colour is one fewer thing to keep in step with `bestContrastTextColor`.**
**The unfloated reservation marker keeps its brand-coloured ring:** that ring is an affordance rather than an
outline (`#48`'s "which colour it'll turn once floated") and at 45% alpha it competes with nothing.
**B&M is a deliberate edge case, recorded because it looks like an oversight.** Its `#34495e` is barely a shade
off this charcoal, so its ring merges into its own fill and the token reads as one solid dark disc with white
lettering — **which is the SECOND outcome this fix was allowed to reach ("remove the border entirely so the
corporate colour fills the whole token"), reached without a special case**, because the property that matters
survives either way: **charcoal-on-white separates at roughly 10:1 whether or not it also contrasts with the
fill inside it.** Tinting B&M's ring lighter would put a pale band back around white lettering — **the exact
bug being fixed — so the merge is the better of the two outcomes rather than a compromise.**

### HexGridRenderer.tsx #487 — The ring is a fraction of the token, not of the hex
**Reported:** subsequent station tokens render with a strange ring that makes them look non-uniform next to
home tokens.
**They do, and the two are drawn by the SAME function with the same colours — which is why this took finding.
The difference is the radius, and the ring did not follow it.** The stroke was `max(2, size · 0.05)` where
`size` is the HEX size — constant for every token on the board — **while the radius is not constant:** a token
docked into a laid tile's city slot shrinks by a chain of factors, and again by 15% on a multi-city tile, while
a home token on an untiled preprinted city keeps the legacy radius.
**So a docked token is roughly two thirds the radius of a preprinted one and wears exactly the same absolute
ring: proportionally half again as heavy** — a small disc with a fat collar beside a large disc with a thin one.
The ratio used is the CURRENT appearance of the legacy path preserved exactly (`0.05 / 0.22`), **so tokens at
the old radius are pixel-identical and every smaller token now wears a ring in proportion to itself.**

### HexGridRenderer.tsx #253 — A brand colour that can act as light
The board veil, the legal-placement glow and the manual route line are all drawn in the acting corporation's
colour, **so one hue says whose turn it is everywhere at once. Two of those three are LIGHT effects over a
darkened board, and light needs luminance:** B&M's slate and PRR's deep red are perfectly good fills and make
almost no glow at all against a veiled map.
**So a colour used as light is measured first, and a too-dark one is BRIGHTENED toward white rather than
replaced by it.** Replacing would throw the identity away exactly when the board is trying to communicate it;
lifting keeps the hue recognisably PRR-red or B&M-navy. The threshold is relative luminance — **the same
quantity `bestContrastTextColor` uses, so this file has one idea of "dark".**

### HexGridRenderer.tsx #403 / #408 — Measure the separation, do not judge it
**#403 — reported:** adjust PRR or NNH so the two are distinguishable. They were `#c0392b` and `#b03a2e` —
**CIELAB ΔE 8.4 apart. Below about 15 two colours read as the same colour under normal viewing**, so on the map,
the chart and eight stock cards the New Haven and the Pennsylvania were effectively one livery. **The
measurement stands and the fix was real; the specific colour it chose does not survive `#408`. The note is kept
because the METHOD is what carried forward.**
**#408 — the colours the board actually uses.** *Reported:* the corporate colours do not match the physical
board game. **This palette was never canonical** — eight plausible, well-spaced hues, tuned for legibility
without anyone asking what colour the pieces actually are. **For a player who knows 1830 that is worse than an
arbitrary palette: the Erie is yellow on the board, and reaching for the yellow token to find it is the B&O
costs more than having no expectation at all.**
Two properties were **re-checked rather than assumed** against the canonical hues:

- **Contrast.** Every entry clears 4.5:1 against whichever of black or white the contrast helper returns — **the
  WCAG threshold for normal text, which is the right bar because the stripe's ticker is 16px bold and 16px bold
  is NOT "large text" by WCAG (that starts at 18.66px bold).** Lowest is B&M green at 5.35:1; **the shade of each
  hue was chosen to clear the bar rather than the bar being lowered to fit a shade.**
- **Separation.** Minimum pairwise ΔE across all 28 combinations is **44.4** (ERIE yellow against NNH orange),
  against the 8.4 that started `#403`. **Canonical and distinguishable turned out not to be in tension — the
  physical game already had to solve this problem with ink on cardboard.**
- **The contrast ink flips where it should:** C&O's cyan, ERIE's yellow and NNH's orange take BLACK; the other
  five take white. **That is the helper doing its job on new inputs, and it is asserted per colour rather than
  trusted.**

**NYC is `#1a1a1a`, not `#000000`.** The requirement allows "a very dark gray to ensure UI legibility": **pure
black would be indistinguishable from the card borders and the chart's gridlines, and a corporation whose livery
is the same colour as the furniture reads as a rendering failure rather than as the New York Central.**

### HexGridRenderer.tsx #428 — Re-exported, not defined
The livery table now lives in `styles/corporationLivery.ts` (see that module for `#408`'s audit and why three
copies became one). `relativeLuminance` and `bestContrastTextColor` moved with it — **generic colour maths that
lived here only because the map's station tokens were the first surface needing to put an acronym on an
arbitrary corporate fill; four other surfaces call them now, and all four are about that palette.**
**The old names survive as aliases, deliberately.** They have eight-plus call sites across the app plus notes
that reference them by name, **and renaming all of that in the same pass that moves the data would make one
behavioural change indistinguishable from forty mechanical ones in review.** The aliases are not
deprecated-and-abandoned: **they are this file's station-token vocabulary, and a hex-map module asking for "the
station ticker colour" reads better here than the generic name would.**

### HexGridRenderer.tsx #141 / #172 / #257 — Why a hex refused a click
A discriminated union, **defined here rather than beside the logic in `hexGeometry.ts` purely to respect the
one-way import rule** — that module imports from this one, so it cannot import back. **The type is data, the
function is behaviour, and the data has to sit at the bottom.**

| reason | meaning |
|---|---|
| `not-a-hex` | not one of the 93 real board hexes |
| `offboard` | a red off-board revenue terminal |
| `gray-immutable` | a preprinted gray hex, permanently fixed |
| `max-tier` | the tile there is already the top colour tier |

**`out-of-reach` is GONE (`#257`).** It was the one reason that depended on whose turn it was rather than on the
board, **and it existed to explain a refusal the Lay Track veil now makes visually. A click on a dimmed hex is
ignored outright, so there is no status left to carry.**
**#172 — `"no-hex"` is distinct from `"blocked"`.** Blocked means "a real hex, but you may not lay here"; this
one carries no reason and no message, **because there is nothing to explain: the player clicked nothing.** It
exists so an already-open in-situ UI can close — **returning silently left a radial menu anchored to an earlier
hex sitting there while the player clicked empty sea to dismiss it.**
**#141 — the static-gate failure is its own variant rather than "report nothing",** for the same reason
`"offline"` is: **the consumer has to make a decision, and the exhaustiveness checker should be the thing that
reminds it.** Reporting nothing was the original behaviour and **is indistinguishable from the click handler
being broken — which is exactly the failure mode this codebase has already hit twice (`#120` and `#139`, both
silent-click bugs).** Consumers MUST NOT open the picker on this status.
**#120 — `"offline"` is a separate status, not a flag on `"success"`.** These placements are **era-gated and
nothing more** — no connectivity check, no terrain reservation, no tray depletion, no upgrade-colour step.
**Folding them into `"success"` would let any consumer treat unvalidated data as authoritative simply by not
knowing to check a flag, whereas a distinct variant makes the exhaustiveness checker point at every site that
has to decide.**

### HexGridRenderer.tsx #71 — G19 is a River hex
New York (G19) is **reclassified River**, matching real 1830's own printed hex definition
(`upgrade=cost:80,terrain:water`). The terrain type drives the build cost, so classifying it by appearance
rather than by the printed rule would have made the crossing free.

> *Not a design note:* `#40` inside `TileGraphics.ts` is a **tile tray number** (the symmetric brown
> triangle), not a note reference. Tile ids and note numbers share the `#N` shape — the surrounding text
> disambiguates.
