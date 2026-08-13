# HexGridRenderer — Design Notes

> **Extracted from `HexGridRenderer.tsx` (monolith split, Phase 0).**
>
> These ~3,180 lines were the file's leading comment block: 26% of a
> 12,051-line source file, sitting above the first `import`, so every reader
> and every editor scrolled past the entire design history of the rail map
> before reaching a line of executable code.
>
> Nothing here was changed in the move — the text is verbatim, only the `//`
> prefixes are stripped. The numbered design notes keep their original
> numbers, and every `design note #N` reference elsewhere in the codebase
> still resolves to the same entry.
>
> **Keep adding to this file.** New design notes belong here, not back in the
> source header. A short pointer is all that remains at the top of
> `HexGridRenderer.tsx`.

---

frontend/src/components/HexGridRenderer.tsx

Milestone 3: the 2D Canvas Graphics Engine's hex-map layer -- renders
`QueryMsg::GetMapGrid`'s response (see `src/msg.rs`'s `MapGridResponse`/
`MapTileEntry`) as a real hex board: tile fills colored by terrain, rail
track paths decoded from each tile's connection bitmask and orientation,
and the three reserved 1830 landmark cities shaded and labeled at their
fixed coordinates. Sibling to the (not yet built) StockMarketRenderer
sketched in frontend_blueprint.md Section 3.3 -- see that document for
how the two compose inside `<GameCanvas>`'s layered `<canvas>` stack.

Design notes:
1. **Pointy-top axial hex geometry, verified against `HEX_NEIGHBOR_OFFSETS`.**
   `hexmap.rs`'s edge indices (0-5) are defined purely by adjacency
   (`HEX_NEIGHBOR_OFFSETS`), not by any pixel angle -- the backend never
   says which screen direction edge 0 points in. This file derives that
   mapping itself: `axialToPixel` is the standard pointy-top axial
   conversion, and `edgeAngleRad(i) = -60 * i` (in degrees, before the
   radian conversion) was reverse-engineered by computing each
   `HEX_NEIGHBOR_OFFSETS[i]` entry's actual pixel delta under that same
   conversion and reading off its angle (edge 0 -> 0deg, edge 1 -> -60deg,
   ... edge 5 -> -300deg / equivalently 60deg) -- NOT the naive `+60 * i`
   a generic hex-corner formula would suggest. Getting this backwards
   would silently draw every tile's track pointing at the wrong
   neighbors while still *looking* like a valid hex grid, so this is
   called out explicitly rather than left as an unexplained sign flip.
2. **Client-side catalog mirrors, not queried.** `GetMapGrid` only
   returns each laid tile's `tile_id` + `orientation` (see
   `MapTileEntry` in `msg.rs`) -- not its connection bitmask, terrain, or
   color -- and there's no query exposing `hexmap::TILE_CATALOG` or
   `hexmap::LANDMARK_HEXES` at all. `TILE_CATALOG`/`LANDMARK_HEXES`
   below are therefore hand-kept TypeScript mirrors of those Rust
   constants. DESIGN GAP: these will silently drift out of sync if the
   backend catalog ever changes without a matching frontend edit; the
   durable fix is a `QueryMsg::GetTileCatalog`-style query (or a codegen
   step off the contract's schema) so the frontend derives this data
   instead of duplicating it by hand. Out of scope for this component;
   flagged here so it isn't mistaken for an oversight, and an unknown
   `tile_id` renders a visible red placeholder rather than silently
   nothing, so a catalog drift is loud instead of invisible.
3. **Track rendering is this component's own convention, not the
   backend's.** `hexmap.rs` itself documents that a tile's connection
   bitmask "records which of its six edges carry a track stub, not how
   those edges pair up internally into a routed path through the tile."
   For a tile with exactly two live edges (the common case), this file
   draws one path between them -- a straight `lineTo` for a true
   opposite-edge pair, an `arcTo` curve otherwise. For a tile with more
   than two live edges (a multi-spur tile like tile 12, or a six-edge
   city hub), it draws a `lineTo` spoke from each live edge into a
   shared center node instead, since the bitmask alone doesn't say which
   pairs are meant to route together. This is a legible, honest
   simplification, not a claim about real 1830 tile art.
3b. **Station Markers & Name Plates.** Every laid tile's terrain now gets
   an explicit destination marker, not just a bare track path: a
   `TerrainType.SmallTown` tile (2 live edges) draws a small solid white
   "dit" circle at its hex center, matching the real 1830 tile-art
   convention (a small dot/crossbar for a town); a
   `TerrainType.MajorCityHub` tile (3+ live edges) draws a larger white
   station circle with a dark outline, instead of the previous plain dark
   junction dot. An ordinary multi-spur *non-city* tile (e.g. tile 12's
   3-edge mountain junction) keeps the small neutral dark dot -- it's a
   track junction, not a passenger destination, so it doesn't get a white
   marker. Every landmark/off-board/dit/station text label now also runs
   through `fitFontSize`, which shrinks the font (down to a floor) until
   `ctx.measureText` confirms it fits within the hex's own flat-to-flat
   width, so a label can never overflow its hex or run into a drawn track
   line regardless of `hexSize`.
4. **Redraw strategy.** Prop-driven redraws (a new `mapGrid`, a resize,
   a `hexSize` change) go through a plain `useEffect` -- simplest and
   cheapest for state that changes only when new chain data arrives.
   Pointer-driven pan/zoom redraws instead go through a
   `requestAnimationFrame`-coalesced scheduler (`scheduleDraw`), so a
   burst of `pointermove`/`wheel` events collapses to at most one canvas
   repaint per animation frame rather than one per event.
5. **One-shot auto-fit, not a permanent camera reset.** On first mount,
   the view pans/zooms once to fit the entire static board outline (see
   note #6) plus every landmark and already-laid tile in frame. After
   that single fit, later `mapGrid` updates redraw in place without
   touching the user's own pan/zoom -- re-fitting on every poll would
   otherwise fight anyone who'd manually navigated the board.
6. **Static board background -- fixes the "blank map at launch" problem,**
   **now the AUTHENTIC 1830 board, not an illustrative approximation.**
   Before this pass, an empty `mapGrid.tiles` (i.e. every game at the
   moment it's created) rendered as nothing but the bare dark canvas
   background -- no board was visible until the first tile was laid.
   `STATIC_BOARD_HEXES` below pre-renders the *entire* real 93-hex 1830
   play area (terrain-classified: plain, mountain, river/water, and the
   red off-board revenue zones) the instant the component mounts.
   SOURCES (cross-verified, not guessed): the official Lookout Games
   "1830: Railways & Robber Barons" rulebook, and the open-source
   18xx.games engine's `lib/engine/game/g_1830/map.rb` (whose `HEXES`
   table is a faithful digital reproduction of the physical board and
   was fetched directly for this pass). Every `label` below (e.g.
   `"G19"`) is the board's own printed coordinate, included specifically
   so this data can be independently re-checked against those sources.
   COORDINATE TRANSFORM: the physical board uses row-letter + column-
   number labels (`layout: pointy`, `axes: {x: :number, y: :letter}` in
   18xx.games' engine), which convert to this file's axial `(q, r)` via
   `r = index of the row letter (A=0 .. K=10)` and
   `q = (columnNumber - 1 - r) / 2`
   (always an integer, since column parity alternates by row on the real
   board) -- this reproduces the engine's own `DIRECTIONS[:pointy]`
   adjacency table exactly. IMPORTANT CORRECTION: an earlier request for
   this feature specified off-board/city coordinates (Canadian Pacific
   "B2", Maritime Provinces "F2", South/Gulf "K13", New York "H12",
   Boston "K6", Baltimore "G15") that were checked against both sources
   above and do NOT match the real board -- e.g. F2 is actually Chicago,
   H12 is Altoona (the Pennsylvania RR's home city), K6 and B2 aren't
   real hexes on this board at all, and G15 is a plain mountain hex, not
   Baltimore. `STATIC_BOARD_HEXES`/`LANDMARK_HEXES` below use the
   verified real coordinates instead (New York = G19, Boston = E23,
   Baltimore = I15, and all seven real red off-board hexes: Chicago F2,
   Canadian West A9+A11, Gulf I1+J2, Deep South K13, Maritime Provinces
   B24) -- see `OFFBOARD_LABELS` below for the full, corrected set.
   CROSS-FILE CONSISTENCY: RESOLVED. A follow-up pass updated the Rust
   backend's `hexmap::LANDMARK_HEXES` (and added `hexmap::OFFBOARD_HEXES`)
   to the same verified real coordinates this file already used --
   New York `(6, 6)`, Boston `(9, 4)`, Baltimore `(3, 8)`, plus all seven
   real off-board hexes. The on-chain reserved landmark/off-board hexes
   and what players see on screen now agree; this file's own coordinates
   were the source of truth that pass aligned the backend to, and were
   left unchanged here. SIMPLIFICATION
   NOTE: the real board also distinguishes "gray" (pre-printed, fixed,
   non-upgradeable track) hexes and per-edge impassable borders from
   ordinary blank hexes; neither distinction is modeled here -- both
   collapse to this file's plain `"Plain"` background type, since this
   layer only ever needed to communicate terrain (Plain/Mountain/River/
   RedOffboard), not the full tile-upgrade rule set. Purely cosmetic
   either way: none of `STATIC_BOARD_HEXES` carries game rules (no cost,
   no connectivity) and none of it is sent to or read from the chain.
6b. **Pre-Printed Track Realism.** A previous pass rendered a laid
   landmark hub tile using the *generic* connection bitmask renderer --
   `hexmap::TILE_CATALOG`'s tile 10/13/14 all use `0b11_1111` (all six
   edges), a deliberate contract-side simplification (see `hexmap.rs`'s
   module doc comment #2), so that generic path drew a full 6-spoke star
   at every landmark regardless of which city it was.
   UPDATE (design note #118): those three old internal ids no longer
   exist, and the tray catalog that replaced them is far less uniform --
   of the four real `MajorCityHub` tiles, only #63 is still all-six-edges
   (#57 is two edges, #14 and #15 are four). The conclusion below is
   UNCHANGED and now rests on firmer ground rather than weaker: a
   landmark's authentic pre-printed track was never a function of
   whichever hub tile happens to sit on it, which is why
   `LANDMARK_TRACKS` is consulted unconditionally and the per-tile
   `drawTrackPath` call is skipped entirely at a landmark hex. Real
   1830's three
   home cities are NOT identical, and their track is *pre-printed on the
   physical board itself* -- not something a player lays -- so
   `LANDMARK_TRACKS` below hardcodes each city's own authentic, fixed
   starting connections and renders them unconditionally in the landmark
   background pass (visible from game launch, independent of whether
   `mapGrid.tiles` happens to contain an entry there), while the laid-tile
   loop now skips its generic track renderer entirely for any tile sitting
   at a landmark hex (it still draws that tile's terrain fill/color-tier
   outline, so a color-tier upgrade remains visible).
   LANDMARK TRACK REALIGNMENT (corrects an earlier pass's edge numbers):
   the first version of this table was built by matching 18xx.games'
   pointy-top `DIRECTIONS` compass LABELS (their documented default
   0=NW,1=W,2=SW,3=SE,4=E,5=NE) against this file's own compass labels
   (0=E,1=NE,2=NW,3=W,4=SW,5=SE, design note #1) -- i.e. "their NW is our
   NW, so translate by name." That assumption turned out to be false for
   1830 specifically: 1830 configures its own `axes` differently from
   the engine's stated default, which flips which physical direction
   each of *their* numeric edge indices actually points to on the real
   printed board. Caught by an independent sanity check: computing New
   York (G19)'s six neighbors under this file's own axial system found
   that our edges 0 (E) and 5 (SE) point at axial coordinates with NO
   real hex in `STATIC_BOARD_HEXES` at all -- impossible for a city
   hex that isn't on the board's edge, and a strong signal the
   compass-label bridging was wrong. RE-VERIFIED against real, NAMED
   neighboring hexes instead of compass labels (18xx.games'
   `LOCATION_NAMES`/`HEXES` tables): New York (G19)'s two disconnected
   stubs point toward F20 ("New Haven & Hartford", the New England
   direction -- our edge 1/NE) and H18 ("Philadelphia & Trenton" -- our
   edge 4/SW), the well-known real "one hex, two independent stations"
   NYC design (one station serving New England, the other serving
   Philadelphia and points south). Boston (E23)'s through-route connects
   D24 (chains toward the Maritime Provinces off-board -- our edge 1/NE)
   and F24 ("Mansfield", chaining to "Providence" -- our edge 5/SE) --
   this one happened to survive the flawed compass-label translation
   unchanged, since {NE, SE} is symmetric under the axis flip that broke
   New York and Baltimore. Baltimore (I15)'s through-route connects I17
   (bordering Philadelphia -- our edge 0/E) and J14 ("Washington" --
   our edge 4/SW), matching 1830's well-known Baltimore/Washington/
   Philadelphia corridor. SOURCES (cross-verified against 18xx.games'
   `lib/engine/game/g_1830/map.rb` tile-definition strings AND its
   `LOCATION_NAMES`/`HEXES` tables for the real neighbor cross-check,
   the same engine cited in note #6): New York is
   `'city=revenue:40;city=revenue:40;path=a:3,b:_0;path=a:0,b:_1'`,
   Boston is `'city=revenue:30;path=a:3,b:_0;path=a:5,b:_0'`, Baltimore
   is `'city=revenue:30;path=a:4,b:_0;path=a:0,b:_0'`. LIMITATION: this
   only models each city's *starting* (Yellow-equivalent) track -- real
   1830's Green/Brown city-tile upgrades change a home city's printed
   track further, which isn't researched or modeled here; an upgraded
   landmark still renders its starting-track shape, just recolored via
   `COLOR_TIER_STROKE`.
6c. **Safe text background box.** Every label pass (`fitFontSize`
   responsively shrinks the font, per note #3b, but that alone doesn't
   stop a legibly-sized label from visually colliding with a track stroke
   or another hex's fill drawn underneath it) now also routes through
   `drawLabelWithBackground`, which paints a small translucent rounded
   rectangle sized to the actual measured text before drawing the text
   itself -- so a landmark name or off-board zone name always has a clean
   patch of contrast behind it regardless of what's drawn beneath.
7. **Interactive Floating Tile-Selection Popup Overlay** -- click
   interceptor, live preview, and dispatch live in three places by
   design, not by accident: (a) this file owns pixel->axial conversion
   AND actually firing the read-only `GetLegalTilePlacements` query
   itself (via the optional structurally-typed `queryClient` prop, so
   this file still never imports `@cosmjs/*` and stays usable with zero
   wallet/session dependency when those props are omitted) -- see
   `handlePointerUp`'s click-vs-drag distance check and
   `onHexClick`/`onHexClickQuery`; (b) the floating card itself
   (`TileSelectionPopup.tsx`) and all of `App.tsx`'s wiring live outside
   this file, consistent with the established "HexGridRenderer is
   presentational, App.tsx owns wallet/session wiring" split documented
   in `App.tsx`'s own comments; (c) the "live map preview" is just this
   file's `previewTile` prop plus one more drawing pass in `draw()` --
   the actual rotation-cycling UI/state lives in `TileSelectionPopup.tsx`.
   ORIENTATION IS A REAL, BINDING CHOICE (STRUCTURAL FIX -- supersedes an
   earlier pass of this note): `ExecuteMsg::LayTile` (see `msg.rs`) now
   takes an explicit, required `orientation` field, and
   `hexmap::execute_lay_tile` commits *exactly* that submitted rotation
   (rejecting the call outright if that specific angle isn't legal) --
   it no longer auto-picks the lowest legal orientation on the caller's
   behalf. A prior version of this contract had no `orientation` input
   at all, which silently removed a genuine 1830 strategic decision
   (which direction a route extends); that auto-pick has since been
   removed. So the orientation-cycling control `TileSelectionPopup.tsx`
   exposes is a real choice, not just a preview: whichever legal
   orientation is selected when "Confirm Placement" is clicked is
   exactly what gets laid on-chain.
8. **Camera Bounds & Zoom Clamping.** `MIN_ZOOM` used to be a flat `0.3`
   constant -- a player could zoom out to roughly 3x further than the
   board itself, surrounding it with a large empty margin. The minimum
   zoom is now DERIVED, not hardcoded: `minZoom` (a `useMemo`) is
   exactly the zoom level that frames the entire real board (every
   `STATIC_BOARD_HEXES`/`LANDMARK_HEXES` hex) with a small 10% margin --
   the same "fit the whole board" computation the one-shot auto-fit
   (design note #5) already used, now also reused as the live floor for
   `handleWheel`. This is deliberately computed from `hexSize`/`width`/
   `height` rather than a magic number, so it stays correct if any of
   those props ever change (a fixed `0.8`/`1.0` would silently be wrong
   for a differently-sized canvas or a resized hex); for this file's own
   defaults (`hexSize=42`, `900x640`) it happens to evaluate to ~0.81,
   squarely in the range this feature's request suggested. Panning is
   now bounds-clamped too, via `clampPanToBoard`/`panClampRange`: a
   single reflected-min/max formula handles both the "zoomed in, board
   bigger than the viewport" case (keep the viewport inside the board)
   and the "zoomed out, board smaller than the viewport" case (keep the
   board inside the viewport) without branching, applied on every
   `handlePointerMove` drag step and every `handleWheel` zoom step (a
   zoom change can itself push a previously-valid pan out of bounds).
   `boardContentBounds` (the board's own unscaled footprint) is
   memoized on `hexSize` alone, deliberately NOT on `mapGrid.tiles` --
   the clampable/fittable area is the fixed physical board, not
   whatever happens to be laid on it yet.
9. **Buildable Terrain Icons vs. Ocean.** A previous pass rendered River
   hexes with a solid blue fill (`#2f5a7a`) and Mountain hexes with a
   solid brown fill -- both real, LAYABLE terrain in 1830 (a river
   crossing or mountain pass tile can be built there, at a terrain
   cost), but the solid, non-land fill colors visually read as
   impassable obstacles instead. River and Mountain hexes now use the
   SAME land fill as an ordinary Plain hex (`BOARD_HEX_FILL`), with the
   terrain communicated instead by an icon -- `drawRiverIcon`'s blue
   vector-line stroke, or `drawMountainIcon`'s brown twin-peak triangle
   -- plus a representative build-cost label (`TERRAIN_BUILD_COST_LABEL`:
   $80 river / $120 mountain, the real 1830 printed terrain costs for
   these two terrain types), rendered with the same safe text-background
   treatment as every other label here (design note #6c). A prior pass
   briefly added a genuinely unbuildable "Ocean" `BoardHexType` for the
   real A13/A15 gap (row A has no hex at columns 13/15) plus a decorative
   ocean/lake backdrop elsewhere on the canvas -- both fully removed, see
   design note #18.
10. **Pre-Printed Off-Board Track.** Every one of the seven red off-board
   revenue hexes (`OFFBOARD_HEXES`/`OFFBOARD_LABELS`) previously rendered
   with zero track at all -- just a red box and a name. Real 1830's
   off-board hexes have printed track stubs where the line runs off the
   edge of the board toward that destination. `OFFBOARD_TRACKS` fixes
   this, SOURCED directly from the open-source 18xx.games engine's
   `lib/engine/game/g_1830/map.rb` (github.com/tobymao/18xx), fetched
   for this pass -- e.g. Chicago (F2) is
   `'offboard=revenue:yellow_40|brown_70;path=a:3,b:_0;path=a:4,b:_0;
   path=a:5,b:_0'`. Their raw edge numbers were translated into this
   file's own edge convention (design note #1) via the SAME verified
   reflection this file already derived for the three landmark cities
   (design note #6b): `our_edge = ((4 - their_edge) % 6 + 6) % 6`.
   RE-VERIFIED independently here (not just trusted from #6b): every
   single one of the 7 hexes' translated edges was checked against
   `HEX_NEIGHBOR_OFFSETS` and confirmed to land on a REAL, existing
   `STATIC_BOARD_HEXES` entry (e.g. Chicago's three edges resolve to the
   real neighbors F4/E3/G3; Maritime Provinces' two edges resolve to
   B22/C23) -- the same "does this edge point at a real hex, or empty
   space" red-flag check that originally caught the landmark bug, now
   passing cleanly for all 7 hexes with zero exceptions, which is strong
   corroborating evidence the reflection formula generalizes correctly
   beyond the 3 cities it was derived from. `drawOffboardTrack` reuses
   `drawLandmarkTrack`'s edge-to-stub geometry but deliberately omits its
   station circle -- an off-board hex is a revenue destination, not a
   real station.
11. **Phase-Dependent Off-Board Value Plates.** `OFFBOARD_REVENUE` adds
   each off-board destination's real printed revenue, also sourced from
   the same `map.rb` fetch (e.g. Chicago is
   `revenue:yellow_40|brown_70`). Real 1830's off-board boxes print
   BOTH tiers on the physical cardboard up front (`"$40/$70"`-style),
   rather than a single value that changes as the game progresses --
   this mirrors that directly, alongside the destination name, both
   behind `drawLabelWithBackground`'s safe box (design note #6c) so
   neither collides with the pre-printed track stubs behind them. NOTE:
   off-board hexes only ever have two tiers here (Yellow/Brown, no
   distinct Green value) -- confirmed from the same source, not an
   omission. This is a purely cosmetic, board-authenticity label: this
   contract has no `ExecuteMsg` for collecting off-board revenue at all
   (`hexmap::OffboardHexNotBuildable` -- these hexes are permanently
   unbuildable, not part of any Operating Round payout), so nothing here
   reads from `GameSession::current_global_era` or any other live game
   state, matching how the physical board itself is static printed
   cardboard, not a dynamic display.
12. **Complete Map Topology & Named Hexes.** Design note #6's own
   "SIMPLIFICATION NOTE" flagged that pre-printed gray hexes and their
   per-edge track collapsed to the plain `"Plain"` background -- this pass
   fixes exactly that gap, plus adds the pre-printed yellow "OO"
   double-city hexes that were entirely unmodeled before. SOURCE
   (verbatim-fetched, cross-checked byte-for-byte across two independent
   mirrors -- raw.githubusercontent.com and github.com/blob -- for this
   pass): `tobymao/18xx`'s `lib/engine/game/g_1830/map.rb`, specifically
   its `HEXES` hash's `gray:`/`yellow:` blocks and its `LOCATION_NAMES`
   table. `GRAY_HEXES` covers all twelve real pre-printed gray hexes
   (Lansing D2, Cleveland F6, a bare connector E9, Altoona H12, Rochester
   D14, Kingston C15, Richmond K15, a bare connector A17, Montreal A19,
   Atlantic City I19, Mansfield F24, a bare connector D24); `YELLOW_OO_HEXES`
   covers the four real pre-printed yellow double-city hexes (Detroit &
   Windsor E5, Hamilton & Toronto D10, Dunkirk & Buffalo E11, Philadelphia
   & Trenton H18) -- New York/Boston/Baltimore are ALSO real pre-printed
   yellow hexes per this same source, but were already modeled with their
   own more detailed `LANDMARK_HEXES`/`LANDMARK_TRACKS` system (design
   note #6b) before this pass, so their TRACK/label/name system is
   deliberately left as-is rather than folded into the new, simpler gray/
   yellow-OO systems. UPDATE (color calibration pass, "Unify All Board
   Yellow Shades"): their FILL COLOR specifically has since been folded
   in after all -- `STATIC_BOARD_HEXES`'s own G19/E23/I15 entries now
   carry `printedColor: "Yellow"` too, so they share the exact same
   `PRINTED_HEX_FILL.Yellow` paint as every OO hex instead of the
   separate translucent per-city tint `LANDMARK_FILL` used to apply (see
   the landmark-shading pass's own comment below for the full rationale)
   -- only their track/label/name modeling stays on the separate,
   detailed system this note originally described. Every gray/yellow
   hex's translated edges were spot-checked the same way design note #10
   already established for off-board hexes (does each translated edge
   point at a real, existing `STATIC_BOARD_HEXES` neighbor?) before being
   committed to `GRAY_HEXES`. `BoardHex.printedColor` composes with the
   EXISTING `type` field rather than replacing it (see that field's own
   doc comment) specifically so a hex like Detroit & Windsor (E5) can be
   both a pre-printed yellow city AND a River hex with its existing river
   icon/cost label -- both are simultaneously true on the real board.
13. **100% Fit-to-Page Camera Toggles.** The camera used to always allow
   free pan/zoom (clamped to the board, per design note #8, but always
   live). It's now a two-state toggle: the DEFAULT baseline pose is
   always exactly `fitView` -- the same "frame the whole board" zoom/pan
   computation design note #8 already derived (`minZoom`, centered on
   `boardContentBounds`), now also enforced as a HARD lock, not just a
   floor -- `detailedView === false` makes `handlePointerMove`/
   `handleWheel` both no-ops (see their own inline comments), so the
   player literally cannot pan or zoom away from the full-board view
   until they opt in. Clicking the new "Toggle Detailed View" button (an
   on-canvas `<button>`, absolutely positioned over a newly-added wrapping
   `<div>` -- the component's root element used to be the bare `<canvas>`
   itself, which had no room to host DOM UI on top of it) flips
   `detailedView` on, jumps the camera to a fixed closer zoom
   (`minZoom * 1.8`, floored at `minZoom + 0.6` so a very small board/
   `minZoom` still produces a noticeably closer view), and enables both
   handlers; clicking it again snaps the camera back to exactly `fitView`
   and re-locks them. NOTE on "100%": this feature's own name calls the
   locked baseline a "100% view scale" -- that's interpreted here as "100%
   of the board fits in the viewport" (i.e. `fitView`/`minZoom`), not a
   literal canvas `zoom === 1.0`, since a literal `1.0` would only
   coincidentally fit any particular `hexSize`/viewport combination
   (exactly the same reasoning design note #8 already used to justify a
   derived, non-hardcoded zoom floor over a magic constant). The click
   interceptor (design note #7) deliberately still works at baseline --
   `handlePointerDown` always arms `dragStateRef` so `handlePointerUp`'s
   click-vs-drag distance check keeps functioning either way; only the
   actual pan/zoom mutation is gated on `detailedView`.
14. **Realistic Topographical Background (REMOVED -- see design note
   #18).** This slot previously held `drawTopographyBackground`, an
   illustrative real-world geography backdrop (Atlantic coastline plus
   Lakes Erie/Ontario/Huron) drawn outside the board's own real edge.
   Request F item 2 asked for exactly the opposite treatment -- a clean,
   solid, neutral background outside the authentic 93-hex footprint, not
   decorative geography -- so the whole function, its `hexDisk` helper,
   and its call site were deleted outright rather than left as dead code.
   Kept as a numbered note (not renumbered away) so this design-note
   index stays stable for anything cross-referencing it.
15. **Adaptive Off-Board Tooltips.** Two related changes, both scoped to
   the red off-board revenue hexes (design notes #6/#10/#11):
   (a) each off-board hex now prints only ONE value inside itself --
   whichever of `OFFBOARD_REVENUE`'s two real tiers applies at the room's
   live `current_global_era` (the new `currentEra` prop, mirroring
   `GameStateResponse.current_global_era` from `src/msg.rs`), via
   `offboardValueForEra`, instead of the previous pass's always-both
   "$40/$70" display. Real 1830 off-board boxes only ever print a Yellow
   and a Brown figure (design note #11) -- there is no separate printed
   Green number, so Green reuses the Yellow figure here exactly as it
   does on the physical board. (b) hovering the pointer over an off-board
   hex (tracked in `handlePointerMove`, independent of drag/`detailedView`
   state so it works even at the locked 100% baseline -- see that
   handler's own comments) now shows `drawOffboardTooltip`'s floating
   card: the full Yellow/Green/Brown progression, color-coded per
   `COLOR_TIER_STROKE`, with the currently active era's row bolded and
   marked "ACTIVE". The card is a CANVAS-drawn element (not a DOM
   overlay like the "Toggle Detailed View" button, design note #13) --
   drawn in the same world-space transform as every other on-canvas
   label in this file, so it pans/zooms consistently with the board
   rather than needing a second, screen-space-fixed overlay system.
16. **Alphanumeric board margin labels.** `drawBoardMarginLabels` stamps
   the real board's own row letters (A-K, one per axial row `r`) along
   the left/right edges and the real board's own printed column numbers
   (parsed straight off each hex's existing `label` field, e.g. `"G19"`
   -> row G's letter plus column 19 -- not an invented 1/2/3 sequence)
   along the top/bottom edges, so a player can locate any hex the same
   way `describeHex`'s own labels already work everywhere else in this
   file. `computeBoardMarginLabels` derives each label's position purely
   from `axialToPixel` itself (a fixed row shares one pixel `y`
   regardless of `q`; a fixed real column number shares one pixel `x`
   regardless of which row's hex supplies it -- the reason the physical
   board's rows/columns print as straight lines in the first place), so
   it can never drift out of sync with design note #1's own conversion.
   Drawn LAST in `draw()`'s world-space pass (after even the ghost
   preview and off-board tooltip), using the same `drawLabelWithBackground`
   safe-contrast convention as every other label here (design note #6c).
   `boardContentBounds`'s own padding was widened (from a flat `hexSize`
   to `hexSize * 2.5`) so these margin labels are fully inside the
   default locked `fitView` pose (design note #13) rather than clipped at
   the canvas edge. A follow-up pass straightened these labels onto one
   consistent bounding line per side -- see the note directly above
   `computeBoardMarginLabels` for the full before/after.
17. **Visual sweep: crisp ocean hex fills (since fully removed -- see
   design note #18), and standalone "+"/"-"/"Fit to Screen" camera
   buttons.** (a) previously repainted `drawTopographyBackground`'s water
   bodies as crisp `hexDisk`-generated hex clusters instead of hand-tuned
   curves; that entire background pass -- crisp or not -- is now gone
   outright per Request F item 2. (b) The "Toggle Detailed View" button
   (design note #13) was the only way to leave the locked `fitView`
   baseline;
   this pass adds three standalone camera-overlay buttons -- "+"/"-"
   (`handleZoomStep`, zooming around the canvas's own screen-space
   center, since a button click has no cursor position to anchor on
   unlike `handleWheel`'s mouse-anchored zoom) and "Fit to Screen"
   (`handleFitToScreen`, an explicit, idempotent snap back to exactly
   `fitView`) -- stacked bottom-right so they never collide with the
   existing top-right toggle. Each of the three works standalone: "+"/
   "-" flips `detailedView` on itself if the camera is still at the
   locked baseline (rather than being a no-op until the separate toggle
   is clicked first), and "Fit to Screen" always re-locks it, regardless
   of whether the camera got to its current pose via drag/wheel or these
   new buttons.
18. **Authentic-footprint-only board (Request F item 2).** Removed every
   hex/decoration that wasn't one of the real 93 board hexes: the two
   fake `A13`/`A15` "Ocean" gap-filler entries (a prior pass's stand-in
   for a real gap that simply has no hex there -- see `STATIC_BOARD_HEXES`'s
   own comment) and `drawTopographyBackground`'s entire decorative
   ocean/lake hex-cluster backdrop (design notes #14/#17a), including its
   `hexDisk`/`OceanClusterAnchor` helpers and its call site in `draw()`.
   The `Ocean` `BoardHexType` variant and its `BOARD_HEX_FILL`/
   `BOARD_HEX_STROKE` entries were deleted too, since nothing uses them
   anymore. `draw()`'s base `ctx.fillRect` -- the color that now shows
   through everywhere outside the real board footprint, including A13/A15's
   genuine gap -- changed from a dark green (`#0e1a12`) to a neutral dark
   charcoal (`#141414`), matching this item's explicit "clean, solid,
   neutral dark charcoal/black background workspace" requirement.
19. **Viewport maximization (Request F item 3).** `width`/`height` are no
   longer required props with fixed pixel defaults (`DEFAULT_WIDTH = 900`/
   `DEFAULT_HEIGHT = 640`) -- when omitted, this component now measures
   its own wrapping `<div>` via `ResizeObserver` and uses that live size
   instead, so the canvas fills 100% of whatever workspace pane hosts it
   (see `App.tsx`'s `boardPane`, changed to stretch its child rather than
   center a fixed-size one). No separate "auto-scale hex radii" logic was
   needed: `minZoom`/`fitView` (design note #8) already compute
   `Math.min(width / boundsWidth, height / boundsHeight)`, so a larger
   measured viewport already yields a larger fit zoom, and every hex
   (`hexSize * zoom` on screen) scales up automatically as the panel
   grows -- this item's "automatically scaling up hex radii" requirement
   was really asking for real width/height to reach that existing
   formula, not a second scaling system.
20. **Margin labels locked to the panel frame (Request F item 4)
   (SUPERSEDED -- see design note #25).** `drawBoardMarginLabels` (design
   note #16) -- the canvas world-space draw pass that painted row
   letters/column numbers -- was removed from `draw()` entirely (and
   deleted, being now dead code at the time). The row/column labels were
   still computed by `computeBoardMarginLabels` (unchanged, still pure
   geometry), but rendered as a `position: absolute` CSS/DOM overlay
   (`MarginLabelsOverlay`, `pointerEvents: "none"`) sized off the LOCKED
   `fitView` transform rather than the live, possibly-panned/zoomed
   `view` -- so the labels always sat at fixed pixel positions relative to
   the outer panel frame and never moved during a pan/zoom drag, matching
   that item's "fixed, permanently visible ... locked directly to the
   outer edges" requirement literally. Design note #25 reverses this
   entire DOM-overlay approach back to native canvas text -- see there.
21. **Active coordinate hover tooltip (Request F item 5).** `handlePointerMove`
   already computed the hovered axial `(q, r)` every frame for the
   off-board-tooltip feature (design note #15b); it now also resolves that
   same `(q, r)` to a board-label string (reusing `describeHex`'s own
   landmark/off-board/plain-hex resolution) and stores it alongside the raw
   `clientX`/`clientY`, in a new `hoveredCoordLabel` state. A small `position:
   fixed` DOM tooltip near the cursor renders "Hovering: <label>" whenever
   that state is non-null (i.e. only while the pointer is over a real hex
   of the authentic board -- silent over the now-plain charcoal background
   outside it, per design note #18, since there's nothing to report there).
22. **Off-board revenue badges + a factual correction (Request F item 6).**
   Each off-board hex's active-value text (design note #15a) is now paired
   with a small circular color-coded badge (fill = `COLOR_TIER_STROKE[currentEra]`,
   i.e. gold/green/brown matching the same era colors used elsewhere in
   this file) drawn just below/right of the zone name plate, with the name
   plate itself pushed up slightly further from hex center -- both purely
   to satisfy this item's "circular value badge ... explicit offset padding
   ... never overlap tracks" ask. The underlying `OFFBOARD_REVENUE` NUMBERS
   were deliberately left unchanged: Request F's own item 6 text asserted a
   3-tier Yellow/Green/Brown progression with specific figures (e.g. Deep
   South 40Y/70G/100B), but this project's own design note #11 already
   documents -- and a fresh re-verification pass against `tobymao/18xx`'s
   `lib/engine/game/g_1830/map.rb` this session re-confirmed -- that the
   real board only ever prints TWO tiers (Yellow/Brown) per off-board box,
   and the actual sourced numbers don't match the ones in the request
   (real Deep South is `30Y/40B`, not `40Y/70G/100B`, for one). Implementing
   the requested numbers verbatim would have replaced already-correct,
   already-sourced data with incorrect data, so they were not applied --
   see this session's final summary for the itemized discrepancy.
23. **Snapped map-frame border (SUPERSEDED -- see design note #24 for the
   final, literal implementation).** A first pass at this geometry
   request added a `boardFrameScreen` memo (a projected, letterboxed-inset
   rect) plus a separately-positioned border div, deliberately avoiding a
   literal `w-fit h-fit` container out of concern it would revert design
   note #19's flex-fill viewport maximization. That concern, and the
   approach it produced, are both superseded by note #24 below: the real
   conflict was never "`w-fit h-fit` vs. viewport maximization" (those
   turn out to be fully compatible, see #24), it was a `ResizeObserver`
   circularity that a second, inner wrapper resolves cleanly. Kept here,
   unrenumbered, purely so this design-note index stays stable for
   anything cross-referencing it.
24. **Literal canvas-edge margin labels (corrects note #23).** The same
   geometry request came back a second time, more specifically: remove the
   `boardFrameScreen`-style projected/letterboxed frame tracking entirely,
   wrap the `<canvas>` and its margin-label overlay in one shared
   `position: relative; margin: 0 auto; width: fit-content; height:
   fit-content` parent (this file's plain-`CSSProperties` translation of
   the request's literal Tailwind `"relative mx-auto w-fit h-fit"`
   example -- still no CSS framework here), and pin the row/column labels
   to that parent's own immediate outer edges rather than an inset rect.
   KEY INSIGHT that resolves note #23's stated concern: the `<canvas>`
   DOM element already renders at exactly `width`x`height` (no DOM-level
   letterbox gap -- design note #19's "empty space" is pixels drawn
   *inside* the canvas by `fitView`'s zoom-to-fit, not empty space around
   the canvas element itself), so a `w-fit h-fit` wrapper around the
   canvas ends up exactly canvas-sized regardless -- `w-fit h-fit` and
   100%-viewport-fill aren't actually in tension. The real hazard was
   circularity: `containerRef` is what `ResizeObserver` measures to
   compute `width`/`height` (design note #19); making THAT SAME div
   `w-fit h-fit` would make its size depend on its canvas child, whose
   size depends on measuring it -- a feedback loop that would freeze at
   the `DEFAULT_WIDTH`/`DEFAULT_HEIGHT` fallback forever. Fixed by adding
   a second, inner wrapper (styled via the new `MAP_FRAME_BORDER_STYLE`,
   repurposed from note #23's border-only div into this full container
   style) nested INSIDE `containerRef`: `containerRef` keeps flex-filling
   the host pane and stays the `ResizeObserver` target exactly as before
   (zero change to note #19's behavior), while the new inner div sizes
   itself purely from its canvas child's explicit pixel `style.width`/
   `style.height` -- a one-directional dependency, no loop. The old
   `boardFrameScreen` memo and its separately-positioned border div are
   deleted outright: framing the map is now a single static `border` on
   the inner wrapper (it's already exactly canvas-sized, so no rect needs
   computing or "tracking" at all). `marginLabelsScreen`'s `leftX`/
   `rightX`/`topY`/`bottomY` fields (each a `hexSize`-derived world-space
   inset, projected through `fitView` -- the "tracking loop" by name) are
   removed the same way; the JSX now anchors row labels directly at
   `left: 4` / `left: width - 4` and column labels at `top: 4` / `top:
   height - 4` -- the canvas's own literal pixel edges, a few px in so
   the centered label glyph (`MARGIN_LABEL_STYLE`'s `translate(-50%,
   -50%)`) isn't clipped by the overlay's `overflow: hidden`. Each
   label's OTHER axis (`row.y`/`column.x`) still goes through
   `computeBoardMarginLabels` + the locked `fitView` projection -- that
   part isn't optional tracking, it's the actual alignment math that
   keeps row G's label level with row G's hexes; only the frame/inset
   computation was redundant "loop" work, not the row/column alignment
   itself.
25. **Native canvas coordinates + canvas bounding-box reset (SUPERSEDES
   #20/#23/#24).** A comprehensive architectural refactor request asked
   to strip out every DOM element built for the margin labels entirely --
   text elements, wrappers, borders -- and draw the row/column labels
   with `ctx.fillText` directly inside the canvas rendering loop instead,
   "so coordinate axes automatically pan, zoom, scale, and align
   perfectly... in real time," plus clean up any "trailing nested
   wrappers or circular container size dependencies" so the map canvas is
   "the direct, clean flex-filled center component of the viewport panel
   window." This reverses notes #20/#23/#24's entire DOM-overlay
   detour -- not because any of it was wrong on its own terms (each pass
   correctly solved the DOM-positioning problem it was given), but
   because moving the labels INTO `draw()`'s own canvas pass eliminates
   that problem's premise altogether: `drawBoardMarginLabels` (restored,
   with `computeBoardMarginLabels` restored to computing both axes again)
   is now called at the very end of `draw()`'s existing
   `ctx.translate(view.panX, view.panY)` / `ctx.scale(view.zoom,
   view.zoom)` world-space transform -- the SAME transform every hex,
   track, and other label in this file already draws through -- so
   alignment with the live (not locked-baseline) `view` falls out
   automatically, with no DOM position, no `fitView` projection, no
   `ResizeObserver`-circularity concern, and no separate "frame" element
   of any kind left to reason about. `MARGIN_LABEL_STYLE` and
   `MAP_FRAME_BORDER_STYLE` are deleted outright, and the inner
   `w-fit h-fit` wrapper div note #24 introduced is deleted too: JSX's
   `containerRef` now wraps a bare `<canvas>` directly, once again "the
   direct... center component" this item's own wording asked for.
   `App.tsx`'s `boardPane`/`canvasPane` styles were reviewed against this
   same "nested wrappers or circular dependencies" concern and left
   unchanged -- `boardPane` already renders `<HexGridRenderer>` as its
   one direct flex-stretched child with no extra nesting of its own, and
   its size comes one-directionally from the surrounding flex layout, not
   from anything inside `HexGridRenderer`, so there was nothing circular
   there to begin with; the circularity this note resolves was always
   internal to this file's own now-deleted inner wrapper.
26. **Camera tightening, value-enriched tooltip, Gulf merge, and value
   badges (5-item mathematical/visual overhaul).** Five items, each
   addressed independently:
   (1) `boardContentBounds`'s `labelPadding = hexSize * 2.5` term and
   `minZoom`'s `* 0.9` margin factor are both removed outright, per this
   item's explicit "completely remove any large hardcoded pixel padding
   or fractional window margin buffers" wording. The bound is now padded
   by exactly `hexSize` -- NOT zero -- since `hexSize` is the hexes' own
   real center-to-corner radius (see `pointOnCircle(center, size,
   cornerAngleRad(i))` in `drawHexPath`); padding by anything less would
   clip the outermost edge hexes' own corners, which is a hex-geometry
   correctness floor, not a "large" cosmetic buffer. ACCEPTED TRADEOFF:
   the native canvas margin-row/column labels (design note #25) are
   still drawn at their own separate `labelOffset = hexSize * 1.15`
   outside the hex extent, independent of this bound -- they are no
   longer guaranteed full clearance inside the locked baseline `fitView`
   now that its padding is 1.15x smaller than before, and may render
   close to (or clipped at) the canvas edge at the default 100% view.
   This is the direct, expected consequence of this item's own literal
   instruction, not an oversight; flagged here rather than silently
   keeping some padding to protect the labels instead.
   (2) `HOVER_TOOLTIP_STYLE` roughly doubled (9px/16px padding, 20px
   bold font, thicker border) and the "Hovering: " prefix dropped so the
   on-screen text matches this item's own literal example exactly. The
   tooltip content now comes from the new `describeHexWithValue`, which
   appends `(Value: $X)` using either the new `hexRouteValue`/
   `terrainBaseValue` (a frontend mirror of `hexmap::terrain_base_value`)
   for ordinary/landmark/gray/yellow-OO hexes, or the EXISTING era-tiered
   `offboardValueForEra` for the red off-board zones (a genuinely
   different, already-era-varying value system -- see note #22).
   (3) Gulf's two hexes (I1/J2) now render as one merged region: the
   static-board fill/stroke pass calls the new `drawHexEdges` helper for
   just these two labels, stroking their five OUTER edges individually
   and skipping the one shared INTERIOR edge (I1's edge 5 / J2's edge 2,
   confirmed via `edgeAngleRad`'s neighbor-direction math against
   `OFFBOARD_TRACKS`'s own "real neighbor I3" comments, which land on
   the same shared edge from both hexes). The off-board nameplate pass
   was factored into a `drawOffboardNameplate` closure and is now called
   ONCE for Gulf, centered at the I1/J2 midpoint, instead of once per
   hex like every other off-board zone. Canadian West (A9/A11) has the
   identical two-hex structure but wasn't part of this request, so it's
   intentionally left unmerged.
   (4) INVESTIGATED, NO BUG FOUND for the gray hexes: `drawPrintedTrack`
   already positions its station/town marker exactly at the drawn
   track's own endpoint in all three cases (a 1-edge stub's midpoint, a
   2-edge segment's `center` -- which for the non-opposite/curved case is
   literally the `arcTo` control point the curve bends through -- and a
   3+-edge junction's shared `center`), and `drawStationCircle`'s filled
   radius (`size * 0.22`) is comfortably larger than the track's own
   stroke width (`size * 0.12`), so the marker fully covers the line's
   end -- there is no floating/disconnected marker in code for Atlantic
   City, Mansfield, Cleveland, Lansing, or Montreal. No code change was
   needed or made for this half of the item. FACTUAL CORRECTION for the
   yellow "OO" hexes (Detroit & Windsor, Dunkirk & Buffalo, Hamilton &
   Toronto, Philadelphia & Trenton): this item asked for connecting
   track between their two stations, but `drawOOCityMarkers`'s own doc
   comment (from an earlier, already-verbatim-verified pass against real
   source tile-definition data) documents that these four hexes
   genuinely have NO printed `path=` connection on the real 1830 board --
   that's their signature feature; a player must upgrade the tile to
   connect the two stations. Fabricating a connection here would make
   the map LESS accurate, so none was added; `drawOOCityMarkers` is
   unchanged.
   (5) A new `drawValueBadge` draws a small color-coded $-value circle
   (amber `$10` for `SmallTown`, crimson `$20` for `MajorCityHub`,
   palette in `VALUE_BADGE_COLOR`) at the upper-right corner of every
   landmark, every gray hex with a city/town marker, every yellow-OO
   hex, and any laid SmallTown/MajorCityHub tile. FACTUAL CORRECTION:
   this item asked for a value "based on the current game phase tier,"
   but `hexmap::terrain_base_value` (the actual backend rule
   `RunManualRoute`'s payout math uses, mirrored here as
   `terrainBaseValue`) is flat and terrain-only -- a hex's $ value never
   changes as the game advances through color tiers, unlike the
   genuinely era-tiered off-board badges (note #22). The two example
   numbers this item gave ($10 towns / $20 base cities) DO match this
   flat table and are used verbatim; what's NOT implemented is a second,
   phase-varying value for the same hex, since the backend has no such
   rule to mirror.
27. **Page-Level Scrolling & True Proportional Scale (item 1 of this
   pass).** The structural calibration pass's `minZoom` fix (see the
   comment above it) deliberately scaled the board to fill BOTH the
   hosting pane's width AND height edge-to-edge, cropping whichever axis
   didn't match the board's own aspect ratio -- which only reads as
   "maximized" when that hosting pane itself is a small, viewport-clamped
   box the player has to pan/zoom inside (see `App.tsx` design note #13
   for exactly how that clamp cascaded down from `appRoot`'s `100vh`).
   This pass removes that ceiling instead: `height` (previously taken
   from the `ResizeObserver`'s own measured container height) is now
   DERIVED from the board's true aspect ratio at the measured `width`
   alone (see the `height` `useMemo` above `minZoom`), and `minZoom`
   fits `width` alone for the same reason -- since `height` now always
   matches `width`'s implied aspect ratio by construction, there is no
   longer a mismatched viewport to crop against. The `<div>`/`<canvas>`
   pair's own DOM height is set to that same derived pixel value (not
   `"100%"`), so it's a real, definite box instead of a percentage that
   would resolve to nothing once no ancestor imposes a height -- and that
   real height is exactly what lets it cascade up through `App.tsx`'s now
   fully un-clamped flex chain to the page itself, where the BROWSER's
   own scrollbar takes over for whatever doesn't fit above the fold.
   "Detailed View" (design note #13's zoom-in toggle) is untouched --
   still lets a player zoom in past this baseline and pan within the
   canvas's own fixed pixel bounds exactly as before.
28. **Inset Canvas Margin Labels (item 2 of this pass).** Design note #26
   item 1's `labelOffset = hexSize * 0.93` only ever cleared the outermost
   hex's own silhouette against the camera's `hexEdgePadding = hexSize`
   visible boundary -- it never accounted for the fact that a drawn
   label's own rendered box (`drawLabelWithBackground`'s text plus its
   background padding) extends further still, past that anchor point, in
   the direction the label reads. A 2-character label, or the background
   box's own padding, could each eat into -- and exceed -- the ~0.07 *
   hexSize of clearance that `0.93` left, silently slicing the label at
   the visible edge exactly as this item reports. `computeBoardMarginLabels`
   now takes the live `ctx` and measures the actual widest row-letter and
   column-number label it's about to draw (`ctx.measureText`, using the
   exact font `drawBoardMarginLabels` already sets before calling it) --
   a real rendered size, not a guessed constant -- and folds that
   half-extent, plus `drawLabelWithBackground`'s own background padding,
   into a single inward `labelSafetyOffset` applied to all four margins,
   so every label's own drawn box (not just its anchor point) stays
   inside the camera's visible boundary.
29. **Reverted Track Rotation Matrix (item 3 of this pass).** The
   structural calibration pass's item 5 (see the "CORRECTED" comments
   still attached to `LANDMARK_TRACKS`/`GRAY_HEXES` below) replaced this
   file's verified edge-reflection formula (`our_edge = ((4 - their_edge)
   % 6 + 6) % 6` -- design notes #6b/#10, independently corroborated
   against real named neighbor hexes for all 3 landmarks AND all 7
   off-board hexes with zero exceptions) with a claimed direct IDENTITY
   mapping, citing its own 470-edge cross-check. RE-INVESTIGATED this
   pass, because the two claims directly contradict each other and this
   file's own established discipline is to verify, not silently trust
   either one: re-deriving New York's two stub edges under the identity
   mapping puts one of them (edge 0/E) at axial `(7, 6)` -- label "G21",
   which does NOT exist anywhere in `STATIC_BOARD_HEXES` (row G's real
   hexes stop at G19, New York itself) -- the exact same "points at a
   nonexistent hex" red flag design note #6b originally used to catch
   the ORIGINAL reflection bug, now catching the IDENTITY claim instead.
   A second, independent case confirms it: Montreal (A19)'s identity-
   mapped edge 0/E lands on axial `(10, 0)` -- label "A21", also absent
   (row A's real hexes stop at A19, Montreal itself) -- literally running
   the track off the printed board's own eastern edge, matching this
   item's own "running sideways into the ocean" description. Since
   reflection is its own inverse, applying the SAME `(4 - e) % 6`
   formula to the identity pass's current (buggy) stored edge values
   exactly recovers the original, doc-verified-correct values (confirmed
   by hand for New York/Boston/Baltimore against this file's own prior
   "New York was `[1]`/`[4]`, Boston was `[1, 5]`" record) -- so that's
   what this pass applies, to both `LANDMARK_TRACKS` (all 3 landmarks)
   and, since the identity bug was table-wide, ALL TWELVE `GRAY_HEXES`
   entries, not just the 5 this item named by city -- reverting the other
   7 (the unnamed connectors and Altoona/Rochester/Kingston/Richmond)
   would leave them on the same broken formula for no principled reason.
   Each reverted hex's own inline comment below shows the before/after
   edge values and which of the two red-flag checks (or simple algebra)
   confirmed it.
30. **Unified Board Yellow Shades (color calibration pass, item 1).** The
   three landmark hexes (New York/Boston/Baltimore) used to get a
   translucent per-city tint (`LANDMARK_FILL` -- red/blue/green at ~20%
   alpha) painted over their ordinary cream `BOARD_HEX_FILL.Plain` base,
   visually distinct from every other real pre-printed yellow hex on the
   board (the OO double-city hexes). Design note #12 already established,
   from the same sourced data as those OO hexes, that these three ARE
   real pre-printed yellow hexes too -- so `STATIC_BOARD_HEXES`'s own
   G19/E23/I15 entries now carry `printedColor: "Yellow"` exactly like an
   OO hex, which routes them through the SAME static-background fill pass
   and the SAME shared `PRINTED_HEX_FILL.Yellow` constant, rather than a
   separate color system -- genuinely "the exact same... fill color", not
   just a matching hex string. FACTUAL CORRECTION: this item's own
   suggested `#FFCC00` example does not match this file's actual OO/
   catalog yellow anywhere -- `PRINTED_HEX_FILL.Yellow` is `#e8d488`, a
   deliberately muted "cardstock" gold (design note #12's own stated
   intent), not a bright saturated color, and no bright/saturated yellow
   fill exists anywhere else in this file to match. Using the literal
   `#FFCC00` value instead would have introduced a FOURTH distinct
   yellow shade rather than unifying to the one the OO hexes already
   share -- so this pass points landmarks at that real shared constant
   instead, which is what actually delivers this item's own stated goal
   of "a uniform visual look across the map." The landmark-shading pass's
   dashed white outline (a separate, deliberate "this hex is a landmark
   station" indicator, unrelated to fill color) is unchanged; only its
   own redundant re-fill is removed.
31. **Axis Text Boundary Inset -- re-verified (item 2).** Re-checked
   design note #28's `ctx.measureText`-based inset after this pass's own
   page-scrolling change (design note #27): the inset math is purely in
   canvas world-space/coordinate terms and doesn't depend on the DOM
   page's own scroll behavior, so it needed no change for that reason.
   Tightened one real imprecision found during the re-check:
   `computeBoardMarginLabels` now takes `drawBoardMarginLabels`'s actual
   `fontSize` (`Math.max(11, hexSize * 0.3)`) as an explicit parameter,
   instead of re-deriving an un-floored `hexSize * 0.3` locally -- at a
   small enough `hexSize` the `11`px floor dominates, and the un-floored
   version would have understated the label's real rendered size (and so
   its real half-extent) by that amount. `BACKGROUND_PADDING_PX = 4` and
   the overall `hexEdgePadding - (halfExtent + padding)` formula are
   otherwise confirmed correct: at the default `hexSize = 42`, the
   resulting inset comfortably clears both a label's measured text width
   and its background box, with `hexEdgePadding` itself exactly matching
   `boardContentBounds`'s own camera-fit padding (design note #27), so
   there is no longer a mismatched-viewport crop (design note #27) that
   could tighten the effectively visible boundary further than this
   function already accounts for.
32. **Unified City Center Station Fills -- re-verified, no discrepancy
   found (this pass, item 1).** This item reported that pre-printed
   yellow "OO" hexes (design note #12, `YELLOW_OO_HEXES`) draw bright
   white station-circle fills while the three landmark hub cities (New
   York/Boston/Baltimore) draw dark/transparent centers. Traced every
   circle-drawing call site in this file before touching anything:
   `drawOOCityMarkers` (the OO hexes' two independent stations),
   `drawLandmarkTrack` (both the 2-edge through-route case, Boston/
   Baltimore, and the 1-edge stub case, New York's own two disconnected
   stations), `drawPrintedTrack`'s `marker === "city"` case (the gray
   hexes' own city markers), and the laid-tile `MajorCityHub` case in the
   generic multi-spur renderer -- EVERY one of these five call sites
   calls the exact same shared `drawStationCircle` helper, which paints
   an unconditional solid `#ffffff` fill with a `#2b2b2b` stroke; there is
   no second, differently-colored circle-drawing path anywhere in this
   file. So per the current source, landmark station centers and OO
   station centers were already pixel-identical white fills before this
   pass touched anything -- no color-mismatch code path exists to fix.
   (Landmark hexes ALSO already share the OO hexes' exact hex-fill
   treatment more broadly, from design note #30's earlier "Unified Board
   Yellow Shades" pass.) FLAGGING rather than silently no-op'ing: if a
   visual mismatch is still visible in a running build, it is not
   reproducible from this file's source as it stands, which points at a
   stale/cached bundle rather than a real code defect -- worth a hard
   browser refresh / rebuild before assuming this item is unresolved.
   Item 2's gold `parGroupFrame`-equivalent note doesn't apply here (that
   was a StockMarketRenderer.tsx item); this file has no separate overlay
   frame to preserve for this item.
33. **Transparent Coordinate Margin Fills (this pass, item 2).** Also
   re-verified rather than taken at face value: `drawBoardMarginLabels`'s
   row-letter/column-number labels were drawn through the same
   `drawLabelWithBackground` convention (design note #6c) as every other
   label in this file, whose DEFAULT background is a translucent WHITE
   box (`rgba(255, 255, 255, 0.72)`), not literal solid black -- so this
   item's exact color description didn't match the source. The
   UNDERLYING complaint is still real and is what this pass fixes: any
   background box at all behind these labels reads as the "ugly block
   outline frame" this item describes, since the margin band sits over
   one uniform solid fill (this component's `#141414` charcoal workspace,
   design note #18) where a contrast box was never earning its keep the
   way it does for labels sitting over busy hex art. `drawLabelWithBackground`
   gained a new `background?: boolean` option (default `true`, so every
   OTHER call site -- city/landmark names, cost labels, off-board
   nameplates, era-tier cards -- is completely unaffected); only
   `drawBoardMarginLabels`'s four label calls now pass `background:
   false`, so no box is drawn there at all -- fully transparent, per this
   item's literal ask. CONSEQUENCE CAUGHT AND FIXED: the margin labels'
   text color, `#1a2e1f` (dark green), was only ever legible against that
   now-removed white box -- against the actual `#141414` charcoal
   underneath, dark green on near-black has effectively no contrast at
   all. Left unchanged, this item would have made the coordinate labels
   functionally invisible rather than "floating cleanly" as asked, so the
   text color was also switched to a bright `#f0f0f0`, matching this
   file's existing light-on-dark convention (e.g. the off-board
   nameplate's `#ffe0e0` text over its own dark box).
34. **Tab-Switching Camera Guard + Complete 1830 Baseline City Database.**
   Item 1: the `ResizeObserver` callback's zero-size guard was `< 1`,
   which only caught a literal zero -- switching this component's tab
   away and back (a re-render toggling the host pane's display, not an
   unmount) can report a transient SINGLE-DIGIT pixel `contentRect` for
   one observation mid-swap, comfortably past that old gate, collapsing
   `measuredSize` (and the whole camera fit) down to it. Widened to
   `<= 10`; simply `return`ing without calling `setMeasuredSize` already
   IS "preserve last known valid settings" -- no separate "remembered"
   state was needed. Item 2: added eight real 1830 city hexes via a new
   `BoardHex.cityDesignation` field (the city-marker counterpart to the
   existing `townDesignation` pattern) -- white station circle (the same
   shared `drawStationCircle` every other real city marker in this file
   uses), name tag, and the SAME flat `MajorCityHub` $20 value badge
   `townDesignation` hexes already get, at F4 (Toledo), F22 (Providence),
   H10 (Pittsburgh), H4 (Columbus), J14 (Washington), H16 (Lancaster),
   B16, and B10 (Barrie). SOURCE VERIFICATION (independently re-derived
   three separate times against `tobymao/18xx`'s `g_1830/map.rb` raw
   source text, this file's own established sourcing convention -- design
   notes #6/#12): all requested coordinates and terrain types (including
   F4/F22/J14's pre-existing `River` type, which already carries the
   correct $80 water-upgrade cost label from design note #9's existing
   terrain-icon pass, unchanged) check out -- EXCEPT two of this item's
   own specifics, which the source does not support and were NOT applied:
   (1) B16's real name is Ottawa, not "Barrington" -- no hex named
   "Barrington" appears anywhere in the source; used Ottawa instead.
   (2) F24's real name is Mansfield (already correctly modeled since
   design note #12, itself independently sourced) -- no hex named "River
   Falls" appears anywhere in the source, so F24 was NOT renamed; kept as
   Mansfield. Also caught and fixed a real label-collision bug this item
   exposed: `NAMED_HEX_LABELS`' name-label pass and the River/Mountain
   terrain-icon pass's cost-label both drew at the identical
   `center.y + hexSize * 0.6` point, so a named River hex's name would
   silently paint over its own "$80" cost label (already true, unnoticed,
   for Detroit & Windsor/Hamilton & Toronto before this pass; now also hit
   by Toledo/Providence/Washington) -- the cost label now shifts to
   `0.85` whenever a name applies, so both stay independently legible.
   Item 3: `computeBoardMarginLabels`/`boardContentBounds` derive their
   bounds purely from each hex's already-fixed `(q, r)` (design note #16)
   -- this pass added FIELDS to eight already-existing `STATIC_BOARD_HEXES`
   entries, not new hexes or new coordinates, so those bounds (and
   therefore design note #33's transparent margin labels) are bit-for-bit
   unchanged; re-verified rather than assumed.
35. **Accurate 1830 Base Value Corrections + Zero-Value Un-Networked
   Cities.** Item 1 (Tab-Switching Guard): re-verified, not re-applied --
   this item is a verbatim repeat of design note #34/item 1, and the
   `observedWidth <= 10 || observedHeight <= 10` gate that item added is
   still exactly in place, unchanged. Items 2-3: added
   `HEX_START_VALUE_OVERRIDE`, a new per-hex-label $ override consulted by
   `hexRouteValue` and the value-badge passes BEFORE their existing
   flat-`terrainBaseValue`-by-terrain fallback -- New York $40, Boston
   $30, Baltimore $30, Montreal (A19) $40, Cleveland (F6) $30 (item 2,
   independently re-derived twice against `tobymao/18xx`'s
   `g_1830/map.rb`: New York's and Montreal's real printed track has TWO
   and one `city=revenue:40` node respectively, Boston/Baltimore/Cleveland
   each one `city=revenue:30` node); the four `YELLOW_OO_HEXES` and the
   eight `cityDesignation` hexes all $0 (item 3, also independently
   re-derived: the OO hexes' real source strings print an explicit
   `city=revenue:0` on BOTH stations, not merely an unspecified value, and
   the eight blank city hexes were already confirmed at $0 in design note
   #34). A $0 override skips the on-canvas badge draw entirely (this
   item's own "fully hiding or removing" instruction) rather than
   printing a literal "$0" plate; `hexRouteValue`'s tooltip figure still
   correctly reports 0 for these hexes (accurate, and useful information
   the badge alone can't convey while hidden). Every hex NOT named by
   this item -- Lansing/Altoona/Rochester/Richmond (the four `GRAY_HEXES`
   city markers item 2 didn't cover) and every `townDesignation` hex --
   is completely untouched, still flat $20/$10 as before. TWO FACTUAL
   CORRECTIONS caught here (see `HEX_START_VALUE_OVERRIDE`'s own doc
   comment for the full sourcing): this item labeled F6 "Chicago" -- F6
   is real, verified Cleveland; Chicago is the unrelated off-board hex F2,
   already on its own separate era-tiered value system this change
   doesn't touch. And this item's "8 newly injected city hubs" list
   actually named nine hexes, including "River Falls F24" -- F24 is
   Mansfield, a `GRAY_HEXES` Town hex (already correctly $10, unrelated to
   design note #34's eight `cityDesignation` city hubs), left untouched
   rather than incorrectly zeroed out. B16 is, again, Ottawa, not
   "Barrington" (design note #34) -- restated, not silently re-applied.
   BACKEND SCOPE NOTE: this item asked for the correction on "both
   layers," but the backend's `hexmap::terrain_base_value` was
   deliberately left untouched -- see that function's own doc comment in
   `src/hexmap.rs` for the full reasoning (in short: it's live payout
   math that would apply to every future color-tier upgrade forever, not
   a "starting" preview figure; and `pathfinding.rs`'s own route tracer
   already scores every untiled hex, landmarks included, at a uniform
   $0 today, so there was no existing hex-specific "starting value" layer
   on the backend to correct in the first place -- only this file's
   on-canvas preview badge has ever shown one). Item 4 (Margin
   Visibility): re-verified rather than assumed, same reasoning as design
   note #34/item 3 -- this pass changed no `STATIC_BOARD_HEXES`
   coordinates, only value-lookup data, so `computeBoardMarginLabels`'s
   bounds and design note #33's transparent-label rendering are
   unaffected.
36. **Station Token markers (backend: `hexmap.rs` module doc comment
   #23).** The backend tracks each corporation's Station Tokens in
   `PublicCompanyState.home_hex_label`/`station_token_hexes`/
   `station_token_limit`, but never drew anything for them -- this item
   adds that rendering. New optional `publicCompanies` prop, typed as
   `StationTokenCompany[]` (a local, hand-kept SUBSET mirror of
   `utils/gameState.ts`'s `PublicCompanyState` -- deliberately
   re-declared here rather than imported, matching this file's own
   design note #2 "client-side mirrors, not shared imports" convention
   and `gameState.ts`'s own `QueryCapableClient` precedent, so this
   otherwise self-contained component keeps no cross-component type
   dependency). `STATION_HOME_HEXES` is a local mirror of
   `hexmap::CORPORATION_HOME_HEX` (originally a 7-of-8-corporations list,
   NNH omitted for the same "no assigned home hex" reason the backend
   omitted it; HISTORICAL as of design note #44's house rule, which gives
   NNH a home too -- see #44) -- needed because a company that hasn't
   floated yet has an
   EMPTY `station_token_hexes` (the free home token is only granted at
   float, by `grant_home_station_token`), so the pre-float "preprinted"
   marker has nowhere else to read its position from. Two drawing
   passes, inserted right after the existing city-circle passes (so
   every token marker layers on TOP of the plain white/gray/OO station
   circle already drawn under it, never the reverse): (1) for each
   `STATION_HOME_HEXES` entry whose matching company is missing from
   `publicCompanies` or not yet `is_floated`, a MUTED marker (translucent
   gray fill, dashed outline) at that preprinted home hex -- "reserved,
   not yet active"; (2) for each floated company, a REAL marker (solid
   `STATION_TICKER_COLORS` fill, solid light outline) at every entry in
   its own `station_token_hexes` -- which, since `grant_home_station_token`
   always inserts the home hex first, naturally covers the home token
   AND any additional paid tokens `ExecuteMsg::PlaceStationToken` places
   later, with no separate rendering path needed for those. Both passes
   share `drawStationTokenMarker`, sized via the SAME `size * 0.22`
   radius `drawStationCircle` already uses ("sized to match the large
   white city circles" was explicit in the request), with the
   corporation's own ticker acronym fit inside via the existing
   `fitFontSize` helper. `STATION_TICKER_COLORS` is a small, deliberately
   DUPLICATED copy of `StockMarketRenderer.tsx`'s own `TICKER_COLORS`
   table (same values, same `company_id` keys) -- duplicated rather than
   imported for the identical cross-component-independence reason as
   `StationTokenCompany` above; if that file's palette is ever
   intentionally re-tuned, this copy needs a matching manual update.
   One board-geometry special case (a second, New York/G19 one, was added
   later by design note #44 once NNH got a home there): ERIE's home hex
   (E11) is a
   `YELLOW_OO_HEXES` double-city hex, whose TWO station circles already
   sit offset left/right of true hex center (`drawOOCityMarkers`) rather
   than AT center -- drawing ERIE's marker at raw center would float it
   visibly between both circles instead of sitting on either, so
   `stationMarkerPoint` special-cases any `STATION_HOME_HEXES`/
   `station_token_hexes` coordinate matching a `YELLOW_OO_HEXES` label
   and offsets it onto that hex's own LEFT station circle (the same
   `size * 0.32` x-offset `drawOOCityMarkers` itself uses) -- the other,
   right-hand circle is left free, matching this hex's real "shared OO
   city" identity (module doc comment #23 flags E11 as shared) even
   though no second corporation is currently assigned there.
42. **Rail Map Overhaul (canvas rendering pipeline + control toolbar).**
   A broad request covering track curves, hex clipping, barrier styling,
   text legibility, layer order, terrain icon scale, a City Names
   visibility toggle, and control-overlay cleanup. Two sub-items were
   checked against this file's own already-verified data and NOT
   implemented as literally worded AT THE TIME, per this project's
   established "verify, don't silently trust a request's own factual
   claims" discipline (design notes #22/#26/#29/#30 all did the same) --
   BOTH ARE NOW HISTORICAL, superseded by design note #44's later,
   explicitly-repeated house-rule request; see #44 for the current
   behavior:
   (a) the request asked for Albany (E19) to carry "the preprinted NYC
   home station reservation token" -- but NYC's real, backend-enforced
   home hex was G19 at the time (`hexmap::CORPORATION_HOME_HEX`,
   `STATION_HOME_HEXES` above, both independently sourced to the real
   board), and a fresh `tobymao/18xx g_1830/map.rb` read this pass
   confirmed E19's own real source string is a bare `'city'` entry -- a
   genuine, blank, valueless city, same category as Toledo/Providence/
   etc., not a home station of any kind on the real board. Implemented at
   the time: E19 gets `cityDesignation: true` (a real white station
   circle) and a `NAMED_HEX_LABELS` entry ("Albany"), exactly like every
   other blank `cityDesignation` city -- see its own
   `HEX_START_VALUE_OVERRIDE` entry for the no-revenue-badge sourcing
   (that sourcing is UNCHANGED by #44 -- Albany's own printed revenue
   doesn't depend on whose home token sits there). NYC's actual home
   token stayed at G19 at the time; #44 later moved it to E19 as an
   explicit house rule. (b) the request separately asked to "assign NYNH
   home token reservation to its designated slot on the yellow New York
   hex (G19)" -- but NNH (this custom board's real ticker for the
   corporation the request calls "NYNH", `public_company.rs`) had NO
   assigned home hex at all at the time, anywhere on this board, by
   deliberate backend design (`hexmap.rs` module doc comment #23, "NNH
   has no assigned home hex... flagged, not guessed" -- independently
   reinforced by a dedicated backend regression test at the time). G19
   was NYC's own real home then; giving NNH a second, fabricated marker
   on the SAME hex would have both contradicted that then-tested backend
   contract and visually collided with NYC's genuine token. Not
   implemented at the time; #44 later gave NNH G19 as its own home once
   NYC vacated it for Albany, resolving the collision this note
   originally flagged.
   Every other item was implemented as requested: `withHexClip`/
   `bezierTrackSegment`/`edgeInwardNormal` (Hex Boundary Clipping Mask +
   perpendicular-entry `ctx.bezierCurveTo` track splines, replacing this
   file's previous `quadraticCurveTo` track curves throughout);
   `drawImpassableBorderEdge` recolored to `#E53E3E` and clamped to a
   literal 3px-4px width; `fillTextWithHalo`/`drawLabelWithBackground`'s
   new `strokeHalo` option (dark `strokeText` outline behind nameplates,
   board margin labels, off-board zone names, and value-badge figures);
   `drawStationTokenMarker`'s muted/reserved badge now pairs a lighter
   soft-gray fill with a DARK acronym overlay (was light-on-gray, low
   contrast); `drawMountainIcon`/`drawRiverIcon` both scaled to `size *
   0.7`; the new `showCityNames` toggle (gates every name-label pass
   only -- station tokens, value badges, and every track spline are
   drawn by separate, unconditional passes); and the old standalone
   "Toggle Detailed View" button is removed outright, with the "+"/"-"/
   "Fit to Screen" buttons and the new City Names toggle consolidated
   into one floating top-right `MAP_CONTROLS_PANEL_STYLE` card, inset
   further from the canvas corner than the old separate buttons were.
   The already-existing layer order (fill -> terrain icons -> track
   splines -> station badges -> name labels, see design note #6c's
   "Track-Under-Text Layer Masking" and `drawHexNameLabel`'s own doc
   comment) already matched this item's requested hierarchy and needed
   no restructuring. `drawValueBadge`'s adaptive corner placement (design
   notes #26/#39, dodges live track edges) was deliberately left as-is
   rather than forced into a fixed lower-third slot -- that adaptive
   system exists specifically to fix a real collision bug a fixed slot
   would reintroduce; the terrain build-cost label (a different,
   unrelated label) already uses a fixed lower-third slot on its own.
43. **Corporate Station Badges follow-up: backend audit + ERIE margin
   placement.** A follow-up request repeated design note #42's Albany/
   NYC-home/NYNH-home/ERIE-hex claims essentially verbatim, plus asked
   for a backend audit of `src/hexmap.rs`. Re-verified from scratch
   against the CURRENT backend at the time (nothing had changed since
   #42): NYC's real home was still `G19` and NNH still had no home hex at
   all (`hexmap::CORPORATION_HOME_HEX`, unchanged at the time) -- so,
   again, no NYC token was added to Albany and no NYNH/NNH token was
   added to G19 at the time, for the exact reasons design note #42
   already gives. HISTORICAL as of design note #44: a later, third,
   explicitly-specific repeat of this same request was implemented as a
   deliberate house rule -- see #44. ERIE's real home hex is still `E11`
   (Dunkirk & Buffalo) on BOTH sides of the stack, not "D6" -- `D6` is a
   real, different, unrelated hex on this board's own axial system (a
   River hex, see `STATIC_BOARD_HEXES`), never associated with ERIE
   anywhere in `hexmap.rs`; this part is UNCHANGED by #44 (ERIE's home
   was not part of that later request). Albany's requested "$20" revenue
   badge was checked again too: still incorrect -- its real source entry
   is a bare `city`, printing no revenue figure at all; also UNCHANGED by
   #44, since that fact doesn't depend on whose home token sits on Albany.

   The backend audit DID surface one genuine, previously-missed gap:
   `hexmap.rs`'s `CITY_DESIGNATED_HEXES` (the on-chain City Reservation
   list gating which hexes may legally receive a `MajorCityHub` tile)
   had no Albany/E19 entry, even though this file's own `cityDesignation`
   flag on E19 (added by design note #42) already rendered it as one
   on-screen -- a real frontend/backend mismatch: a Protocol attempting
   to actually upgrade Albany on-chain would have been illegally
   rejected despite the frontend showing a legal-looking city marker.
   Fixed backend-side (`hexmap.rs`'s own matching doc comment on that
   same const), not here -- no frontend change was needed for this half
   of the item, since `HexGridRenderer.tsx` doesn't independently gate
   tile legality (it queries `QueryMsg::GetLegalTilePlacements`, which
   now correctly includes Albany once the backend fix lands on-chain).

   One item WAS a genuine frontend refinement, independent of the wrong
   "D6" coordinate: ERIE's RESERVED (not-yet-floated) badge previously
   rendered anchored onto E11's own LEFT station circle
   (`stationMarkerPoint`'s existing OO-hex offset, design note #36) --
   which could misleadingly read as "ERIE's home is specifically the
   left slot," when real 1830 actually lets ERIE's President choose
   EITHER of E11's two slots on its first Operating Round turn after
   floating (`hexmap.rs` module doc comment #23). The muted/reserved
   pass now special-cases any `YELLOW_OO_HEXES` home hex to draw in
   neutral margin space below both circles instead (`center.y + hexSize *
   0.46`, comfortably inside the hex's own apothem and clear of both
   station circles) -- reading as "reserved, slot not yet chosen" rather
   than committing to one. The REAL, floated token (once ERIE actually
   floats) is UNCHANGED -- still `stationMarkerPoint`'s left-circle
   convention -- since the chain itself only ever records E11's one
   `(q, r)`, never which corner was picked (same known simplification
   design note #36 already flagged), so there's no real per-corner data
   for the floated marker to reflect either way.
44. **House-Rule Home Reassignment: NYC/Albany, NYNH/New York (mirrors
   `hexmap.rs` module doc comment #25).** Design notes #36/#42/#43 all
   independently verified, and twice declined, this exact NYC-home-moves-
   to-Albany / NNH-gets-G19 request as factually inconsistent with real
   1830 (NYC's real home is G19; NNH has no real 1830 analogue with a
   separate home at all in this custom board's design). On a third,
   explicit, more specific repeat -- now paired with an equally explicit
   backend request to change `hexmap::CORPORATION_HOME_HEX` itself -- this
   is implemented as the deliberate house rule it clearly now is for this
   custom board, matching the backend change: see `hexmap.rs` module doc
   comment #25 for the full mechanical-safety verification (home tokens
   are decoupled from tile-laying, so this is purely cosmetic/
   informational on both sides of the stack). `STATION_HOME_HEXES` above
   now gives NYC (company_id 2) Albany E19 and NNH (company_id 7, "NYNH")
   New York G19 -- the hex NYC vacated -- a clean swap, no collision,
   mirroring the backend const entry-for-entry.

   Three rendering consequences, all implemented this pass:
   (a) Albany (E19) already had `cityDesignation: true` and a "Albany"
   `NAMED_HEX_LABELS` nameplate from design note #42 -- the preprinted
   "NYC" reserved/home badge now appears there "for free" once
   `STATION_HOME_HEXES` points NYC at E19, since the muted-badge-drawing
   pass already iterates that list generically. Albany's revenue badge is
   still deliberately NOT added -- its real source entry prints no
   revenue figure at all (`HEX_START_VALUE_OVERRIDE["E19"] = 0`, see
   design note #42's own sourcing), and that fact is unaffected by whose
   home token happens to sit there now; a "$20 base revenue badge" would
   still be inventing a figure with no source.
   (b) NNH's reserved/home badge, now real, needed a placement fix New
   York's own geometry requires: G19 is a `LANDMARK_HEXES` hex with TWO
   disconnected stub stations (`LANDMARK_TRACKS["New York"]`, design note
   #6b), not raw hex center and not a `YELLOW_OO_HEXES` hex either, so
   `stationMarkerPoint`'s existing OO-hex special case didn't cover it --
   without a fix, NNH's badge would've drawn at New York's literal center,
   floating in the gap between both real stub stations (exactly the "do
   not render floating in the middle of the hex" outcome explicitly
   flagged against). Added a second special case to `stationMarkerPoint`
   (see its own updated doc comment) anchoring any G19 marker onto the
   NORTHEAST of the two stub stations specifically (edge 1 under this
   file's own `edgeAngleRad` convention, design note #1) via the exact
   same stub-station formula `drawLandmarkTrack` itself already uses for
   that segment, rather than a second, independently-drifting copy of
   that geometry.
   (c) ERIE's existing margin-badge placement (design note #43) is
   untouched by this pass -- ERIE's own home hex (E11) was not part of
   this request.

   Acronym badges on every home/reserved token -- muted soft-gray fill,
   bold dark acronym text, for every `STATION_HOME_HEXES` entry not yet
   floated -- were already fully implemented by design note #36's
   `drawStationTokenMarker` and design note #42's contrast fix; this pass
   re-verified that behavior against the current, wider 8-of-8
   `STATION_HOME_HEXES` list and found no further change needed.
45. **Corporate Acronym Overlay guarantee (CORRECTS design note #44's own
   "found no further change needed" claim above).** A follow-up request
   reported reserved/unfloated home badges rendering as plain gray/dashed
   circles with no acronym text at all -- design note #44 had just
   re-verified this exact rendering path and concluded it needed no
   change; that conclusion was WRONG, and this note corrects it rather
   than silently rewriting #44's text. Root cause, found by re-reading the
   muted-pass call site rather than just `drawStationTokenMarker` itself:
   the reserved pass has always called `drawStationTokenMarker` with
   `company?.ticker ?? ""` -- and `publicCompanies` is an OPTIONAL prop
   (design note #36 already documented "before the host app's first
   `GetGameState` query resolves" as a real, expected state) that's often
   empty or not yet loaded on first paint. In that window,
   `company` is `undefined`, the ticker argument is `""`, and
   `drawStationTokenMarker`'s own `if (!ticker) return;` guard -- present
   since design note #36 -- silently skips the ENTIRE text-drawing block,
   leaving a bare circle with no acronym at all. Design note #44's
   re-verification checked the drawing function's styling logic (colors,
   font, contrast) and found it correct, but never actually exercised the
   "`publicCompanies` not loaded yet" path that #36 itself had already
   flagged as a real possibility -- that's the gap this note closes.

   Fix: added `STATION_TICKER_LABELS`/`stationTickerLabel` -- a small,
   static, duplicated copy of `public_company.rs`'s real on-chain tickers
   (same "copy, don't import" convention as `STATION_TICKER_COLORS`),
   keyed by `company_id`, so the correct acronym is available with NO
   dependency on `publicCompanies` ever loading. The muted call site now
   passes `company?.ticker || stationTickerLabel(home.companyId)` --
   live data wins if present, but the fallback is never an empty string,
   so every one of the 8 `STATION_HOME_HEXES` entries draws its acronym
   unconditionally on every paint. Company 7's static label is `NNH` (its
   real on-chain ticker, `public_company.rs`'s `CORE_PUBLIC_COMPANIES`),
   not the request's own "NYNH" wording, so the placeholder text matches
   exactly what `company.ticker` will show once that corporation actually
   floats -- avoiding a visible acronym flip at that moment, consistent
   with design note #36's own established "NNH is this board's real
   ticker, NYNH is the request's colloquial name for it" distinction.

   Also added, as explicitly requested and independent of the bug fix
   above: an opaque, solid `#000000` `strokeText` halo (`lineWidth = 2`,
   `lineJoin = "round"`) painted immediately before every acronym's
   `fillText` call, in both the muted and floated branches -- deliberately
   NOT routed through this file's existing `fillTextWithHalo` helper
   (design note #42), which uses a larger, semi-transparent 3px halo
   tuned for bigger labels drawn over busy track/terrain fills; this
   badge is small (`radius = size * 0.22`) and already sits on a flat
   color, so a smaller fully-opaque halo reads crisply on a short 2-4
   letter acronym without swallowing its glyph strokes. Font sizing
   deliberately stays on the existing adaptive `fitFontSize` helper
   rather than switching to a literal fixed `'bold 11px sans-serif'` as
   the request's own wording suggested -- `hexSize` (and therefore
   `radius`) is dynamic (pan/zoom, `ResizeObserver`-driven auto-fit, see
   design note #27), so a fixed px size would either overflow the badge
   at low zoom or read illegibly small at high zoom; `fitFontSize` is
   already this file's own established solution to exactly that problem
   for every other in-canvas label, and was kept rather than replaced by
   a fixed value it would fight against.
46. **Crisp Token Typography (CORRECTS design note #45's own halo
   weight).** A follow-up report: acronym text inside station badges was
   an illegible blob. Root cause was exactly what it looked like -- #45's
   own `lineWidth = 2` `strokeText` halo, at this badge's small `radius =
   size * 0.22` and an as-small-as-9px (previously as-small-as-6px)
   glyph, is thick enough to fill in tight letterform counters (the "B"s
   in B&O/B&M, the "O" in B&O/CPR, the "&" itself) -- a real regression
   #45 introduced while fixing a different, real bug (see #45's own text
   for that one). Thinned to the requested `lineWidth = 0.5` (kept, not
   removed outright, since a thin edge still measurably helps at extreme
   zoom-out) and recolored to the OPPOSITE of each badge's own computed
   text color (`bestContrastTextColor`, new this pass) rather than a
   fixed `#000000` -- so it reads as a thin contrast-boosting edge in
   every case, including the badges whose best text color is now black
   (see below), where a black halo behind black text would have done
   nothing at all.

   Badge fill/text colors overhauled together, both requested and to keep
   the halo fix internally consistent: (a) reserved/unfloated badges now
   fill solid, opaque `#1E293B` (one of the two literal values requested;
   picked over `#334155` for its clearly higher contrast headroom --
   ~14.6:1 vs. white, vs. `#334155`'s ~10.3:1, both comfortably past the
   7:1 AAA line but `#1E293B` leaves more margin) with pure white
   (`#FFFFFF`) acronym text, replacing the previous translucent light-gray
   fill with dark text -- a much larger, unambiguous jump in contrast, not
   a marginal tweak. (b) Floated badges keep their existing corporate
   `STATION_TICKER_COLORS` fill (unchanged, out of scope -- see below) but
   now pick whichever of pure white/pure black actually contrasts better
   against that specific color, computed via `bestContrastTextColor`'s
   real WCAG relative-luminance formula, rather than the previous fixed
   light-cream (`#f4ecd8`) fill used for every corporation alike.

   HONEST LIMITATION, flagged rather than silently claimed away: the
   request asked for "high contrast standards (WCAG AAA)" on floated
   badges specifically. Checked the actual numbers rather than asserting
   it: `STATION_TICKER_COLORS`'s eight established brand colors (design
   note #36, deliberately duplicated from `StockMarketRenderer.tsx`'s own
   `TICKER_COLORS` -- re-tuning that shared palette is out of scope here)
   only reach the literal 7:1 AAA threshold, against EITHER pure white or
   pure black, for three of the eight: B&O (~7.3:1, black), C&O (~7.4:1,
   black), B&M (~9.3:1, white). The other five's own BEST available
   choice still falls short of 7:1 -- PRR ~5.4:1 (white), CPR ~5.9:1
   (white), ERIE ~6.4:1 (black), NNH ~6.0:1 (white), and NYC the tightest
   at ~4.9:1 (black) -- all comfortably clear of the lower 4.5:1 AA
   threshold for normal text, but genuinely short of AAA. This is a
   property of the brand palette itself, not a bug in the color-picking
   logic (`bestContrastTextColor` always returns whichever option is
   measurably better); reaching true AAA for all eight would require
   darkening/lightening the corporate colors themselves, which would also
   de-sync them from `StockMarketRenderer.tsx`'s own copy -- flagged for
   a future pass rather than done silently here.

   Font family: `fitFontSize`'s generic `sans-serif` became the requested
   explicit `system-ui, -apple-system, sans-serif` stack (new
   `FONT_FAMILY_STACK` constant) -- applied to `fitFontSize` itself, so
   all eight of its call sites across this file benefit at once, since a
   font-family swap (unlike a size floor) can't overflow any caller's own
   `maxWidthPx`: `fitFontSize`'s own shrink-to-fit loop re-measures
   against whatever font actually resolves and backs off further if
   needed, same as it always has. Minimum font size floor: raised from 6
   to 9 for the station-badge acronym call site specifically (this
   function's own `minFontSizePx` argument), NOT inside `fitFontSize`
   itself -- seven other call sites in this file share that helper with
   their own independently-tuned minimums (5px for off-board value
   badges, 6-7px for name/cost labels), and a shared global 9px floor
   would silently override every one of those and risk overflowing their
   own, much tighter `maxWidthPx` budgets. The floor this request asked
   for is real, just applied at the one call site it was actually about.
47. **Canonical Tile Upgrade Restrictions: "B" / "NY" / "OO" badges,
   Dynamic City Nameplate Suppression, and off-board label offsets**
   (mirrors `hexmap.rs` module doc comment #26 for the backend half of
   this request). Four independent pieces:

   (a) NEW "B"/"NY"/"OO" restriction badges (`drawRestrictionBadge`, new
   this pass) at Boston, New York, and the four `YELLOW_OO_HEXES` --
   purely informational, drawn at each hex's own upper-left geometric
   corner (see that function's own doc comment for why NOT the same
   mid-radius zone `drawValueBadge` uses), gated on `!hexHasLaidTile`
   (part (c) below) per the request's own "before tiles are laid"
   framing. No client-side legality re-check was added anywhere --
   `TileSelectionPopup.tsx`'s own design note #4 already established
   "no client-side re-validation of legality" as this project's
   standing policy, and the backend's new `hexmap::legal_tile_placements`
   restriction (module doc comment #26) already flows through
   automatically with zero frontend catalog to keep in sync.

   (b) A genuine, previously-uncaught gap fixed as a load-bearing
   prerequisite for (c): `describeHex` (the hover-tooltip name source)
   only ever special-cased `LANDMARK_HEXES` and `OFFBOARD_LABELS` --
   every `NAMED_HEX_LABELS` city (Washington, Toledo, Providence, Albany,
   Cleveland, Altoona, the four OO names, the three double-town names --
   everything that isn't a landmark or off-board zone) fell through to
   the bare coordinate label (e.g. "J14") with no city name at all. Not
   a problem on its own before this pass, but about to become one: once
   (c) suppresses a tiled hex's ON-CANVAS nameplate, the tooltip becomes
   the ONLY remaining place that name is shown -- so `describeHex` was
   extended to also consult `NAMED_HEX_LABELS` before falling back to
   the bare label, closing the gap for every affected hex at once, not
   just the ones this request happens to mention.

   (c) Dynamic City Nameplate Suppression (`hexHasLaidTile`, new this
   pass): physical-board parity -- laying a tile covers the hex's
   preprinted name in real 1830, so this file's four PREPRINTED-name
   drawing passes (landmark labels, the single-name `NAMED_HEX_LABELS`
   pass, the OO stacked-name pass, the double-town stacked-name pass)
   each gained one more skip condition alongside their existing
   `showCityNames` toggle check. Deliberately NOT applied to
   `drawOffboardNameplate` (an off-board hex can never receive a laid
   tile at all, `hexmap.rs` module doc comment #14, so the check would
   always be false there) or to the value-badge pass (this request's own
   "text plate" wording was about names, not the $ badges, which keep
   showing regardless of tile state as they always have). The name
   remains 100% available on hover per (b) above and per the tooltip's
   own pre-existing "no tile-laid gate" behavior (unchanged by this
   pass).

   (d) Nameplate text and off-board label offsets: Washington's
   `NAMED_HEX_LABELS` entry (`J14`) is now `"Washington, D.C."`, was the
   bare `"Washington"` -- `fitFontSize`'s existing shrink-to-fit already
   absorbs the longer string at any zoom, no separate width tuning
   needed. `drawOffboardNameplate` now splits any multi-word off-board
   name ("Canadian West", "Deep South", "Maritime Provinces") into two
   stacked lines at the first space, same "A & B" stacking shape the
   OO/double-town name passes already use -- reported specifically for
   "Maritime Provinces" (this board's single longest off-board name, on
   a single, non-merged hex, previously squeezed onto one line), applied
   uniformly to every multi-word zone name rather than special-cased to
   just that one. Single-word names ("Chicago", "Gulf") are unaffected.
   The broader "inspect for track/border collisions" ask turned up no
   other concrete, reproducible collision beyond the Maritime Provinces
   case above -- design note #22's existing offset padding
   (`center.y -/+ hexSize * 0.42/0.44`) and design note #39's adaptive
   `BADGE_CORNERS` system for landmark value badges were both
   re-verified against their own already-documented reasoning and left
   unchanged rather than adjusted without a specific, identified
   collision to fix.

   UPDATE (design note #49): part (a)'s badge styling (dark navy pill,
   white text) and persistence (`!hexHasLaidTile` gate) are BOTH reversed
   by that later pass -- see #49 for the current, full design. This note
   is left as-is for history rather than rewritten.
48. **Solid Corporate Brand Color Borders (reserved/unfloated station
   tokens).** `drawStationTokenMarker`'s muted (reserved, not-yet-
   floated) badge outline was a dashed, near-white `#e4e7ec` ring, sized
   to `hexSize` (`Math.max(2, size * 0.05)`) -- reported as visual noise,
   and carrying no information a player could act on. Replaced with a
   solid ring in the SAME corporate brand color (`STATION_TICKER_COLORS`)
   that badge's own company will fill with once floated -- a reserved
   badge now previews its eventual color at a glance, before the acronym
   text is even read, rather than a generic gray outline every
   corporation shared. Fixed at `1.75px` (within the requested
   1.5px-2px range) rather than scaled with `hexSize` like most of this
   file's other strokes -- deliberate: a thin, CONSTANT ring reads as
   clean and intentional at every zoom level, where a size-scaled one
   would balloon into a heavy band at high zoom, working against the
   "eliminate noise" goal this pass was actually asked for. The badge
   fill (`#1E293B`, design note #46) and the acronym's own
   `bestContrastTextColor`-computed fill/halo (also #46) are both
   unchanged -- the fill sits well inside this ring with no visual
   overlap, since the ring is thin and drawn AT the circle's own radius
   (`ctx.arc`'s stroke straddles that path, not inset into the interior
   the text occupies). Floated badges' own outline (`#f4ecd8`, solid,
   `hexSize`-scaled) is unchanged -- this request was scoped to the
   reserved/unfloated case specifically, not every token.
49. **"B"/"NY"/"OO" Tile Manifest Completion, Persistent Plain-Text
   Restriction Labels, and OO Diagonal Geometry Refactor** (mirrors
   `hexmap.rs` module doc comment #27 for the backend half of this
   request). Four independent pieces:

   (a) Tile Manifest Completion -- a genuine, previously-uncaught
   cross-file gap, fixed as a load-bearing prerequisite for the rest of
   this pass: `TerrainType`/`TILE_CATALOG` here never gained entries for
   `BostonHub`/`NewYorkHub` (added to the BACKEND catalog by module doc
   comment #26, tiles 16/17) at all. Concretely, `TILE_CATALOG_BY_ID.get(16)`
   always returned `undefined`, so the main board renderer's own
   fallback paths kicked in for a laid Boston/New York Green tile: its
   hex OUTLINE rendered in the "unknown tile" fallback red
   (`#c0392b`) instead of the real Green/Brown tier stroke, and its
   `TileSelectionPopup.tsx` picker thumbnail (`TilePreviewThumbnail`)
   rendered as a bare "#16?" placeholder instead of real tile art. Closed
   by mirroring `hexmap::TILE_CATALOG` tiles 16-24 here exactly (see
   `TerrainType`'s own updated doc comment) -- `BostonHub` renders like
   `MajorCityHub` (one station), `NewYorkHub` like the OLD `DoubleCityHub`
   layout (two stations, side by side -- a legally separate reservation
   from OO per module doc comment #26/#27, so it does NOT adopt part (c)
   below's new diagonal geometry).

   (b) Persistent, Plain Restriction Labels -- TWO explicit reversals of
   design note #47's own decisions on `drawRestrictionBadge`, both left
   in place there for history (see #47's own "UPDATE" pointer) rather
   than rewritten: (i) styling -- plain, crisp `#000000` text, NO
   background pill/box/circle of any kind (was a `#0f172a` navy box with
   white text); the corner anchor's radius fraction is pulled in from
   `apothem * 0.85` to `0.7` so the now-unboxed glyphs stay clearly inset
   within the hex border at every zoom level, not just at the box's old
   padded edge. (ii) persistence -- both call sites' `!hexHasLaidTile`
   gate is removed outright, so "B"/"NY"/"OO" now stay visible across
   every tile phase (un-tiled preprinted hex, Yellow, Green, Brown) --
   the opposite of #47's own explicit "before tiles are laid" framing.
   Per the request's own wording, this is purely informational styling;
   it changes nothing about which tile artwork is actually LEGAL where --
   that's still entirely `hexmap::legal_tile_placements`' job (module doc
   comment #26/#27), unaffected by any of this file's rendering choices.

   Also folded in here: Baltimore now gets a "B" badge alongside Boston
   (real 1830 prints "B" on both hexes, not just Boston -- see backend
   module doc comment #27's own Verification Status paragraph for the
   sourcing caveat this carries).

   (c) OO Diagonal Geometry Refactor -- `drawOOCityMarkers`'s two station
   circles move from left/right (design note #12) to a top-right/
   bottom-left DIAGONAL (`ooCityMarkerOffset`, a new shared helper so the
   pre-laid marker and a laid tile's own `drawTrackPath` `DoubleCityHub`
   branch can never drift out of sync with each other), per the
   request's own explicit wording. `stationMarkerPoint`'s matching
   `YELLOW_OO_HEXES` anchor moves with it (previously the LEFT circle,
   now the bottom-left one, via the same shared offset rather than a
   second hand-computed literal).

   Everything else in this hex was repositioned to stay clear of the new
   diagonal circles: the stacked dual-city nameplate (design note #41)
   moves from the upper-third band every other name label uses to TRUE
   HEX CENTER -- the genuinely open space between a top-right and a
   bottom-left circle is the middle of the hex, not the top. The two OO
   hexes that are ALSO real River hexes (D10/E5) get their water icon and
   $80 terrain-cost label moved into the bottom-right quadrant (the one
   remaining open corner), with the icon scaled to `hexSize * 0.6` (~40%
   smaller than the standard `hexSize` scale) so it comfortably fits
   alongside the label without overlapping the diagonal circles, the
   track splines converging on them, or the re-centered nameplate. Every
   other Mountain/River hex on the board (not one of the four OO hexes)
   is completely unaffected -- still centered, still full-size.
50. **Standardized City Nameplate Typography & Expanded OO Diagonal
   Offset.** Three pieces:

   (a) Strip Pills, Boxes & Halos: `drawHexNameLabel` (item 7, "Muted
   Base Text with Hover Glow") REPLACED entirely -- no more
   `drawLabelWithBackground` translucent plate, no more `strokeHalo`
   dark-stroke-outline pass, no more hover drop shadow. Every city/town/
   landmark nameplate this function draws (landmark names, gray/
   `NAMED_HEX_LABELS` single names, and both stacked-pair passes below)
   is now a single plain `ctx.fillText` in solid `#000000`, painted
   directly on the hex's own fill -- nothing drawn behind or around it.
   Item 7 itself is left in place at its own comment, unedited, for
   history, same as this file's established convention for a superseded
   decision (see e.g. #47's own "UPDATE" pointer to #49).

   (b) Standardized Font Sizing: `NAMEPLATE_FONT_SIZE_PX`/
   `NAMEPLATE_FONT_MIN_PX` (10/8, `drawHexNameLabel`'s own doc comment
   has the full reasoning) replace the OLD base-10/min-6 (rest) and
   base-13/min-7 (hover) `fitFontSize` calls -- a genuinely narrow 2px
   band that only actually engages for the handful of long single-line
   outlier names ("Washington, D.C.", "Atlantic City"); every other name
   on the board, including both halves of every OO/double-town stacked
   pair, now renders at the exact same 10px. Hover no longer changes
   size at all (the OLD 10->13 swing was the single biggest source of
   "wild fluctuation" here) -- weight (normal/bold) is the only
   remaining hover cue, which doesn't reintroduce a size fluctuation.
   TRADEOFF, stated plainly rather than left implicit: a genuinely
   zero-tolerance FIXED size (no shrink band at all) was considered and
   rejected -- it would make "Washington, D.C." and "Atlantic City"
   visibly overflow their own hex's flat width at default zoom, which
   reads as a worse defect than a 2px band covering two outlier names
   out of this board's ~32 real city/town names.

   (c) Expanded OO Diagonal Offset: `ooCityMarkerOffset`'s magnitude
   widened from `0.3` (design note #49) to `0.43`, within the requested
   `~0.42-0.45` range -- see that function's own doc comment for the
   "still safely inside the hex" distance check. The OO stacked-pair
   nameplate's own `lineOffset` (the vertical gap between its two lines,
   dead-center per #49) widened `0.19` -> `0.24` to match, for more
   generous margin clearance now that the circles sit further out.

   NOTE on the OO/double-town split itself (UNCHANGED this pass, still
   `name.split(" & ")` -> two lines, "A" / "B", the ampersand dropped
   entirely): the request's own two worked examples disagree with each
   other on this point -- one shows "Philadelphia" / "Trenton" (no "&"
   on either line, matching this file's existing #49 behavior exactly),
   the other shows "Detroit &" / "Windsor" (the ampersand KEPT, attached
   to line 1). Rather than silently picking one, this pass keeps the
   EXISTING ampersand-dropped convention -- it matches the first example
   verbatim, it's what real 1830-style boards print (two bare city names
   stacked, no punctuation), and it's what #49 already built and this
   request's own task title ("match standard 18xx board aesthetics")
   points toward -- but this is flagged here explicitly as a judgment
   call on an inconsistent spec, not a silent assumption.

   UPDATE (design note #51): point (a) above ("no more
   `drawLabelWithBackground` ... nothing drawn behind or around it") is
   PARTIALLY reversed -- `drawHexNameLabel` once again draws a tight
   background box behind the text, for the track-occlusion reason #51
   explains. This is NOT a revival of the pre-#50 dark floating pill:
   the new box is a near-rectangular (corner radius 1px), zero-stroke,
   zero-shadow, 2.5px-padding shape filled with a color matched to the
   hex's own surface, sized just large enough to cover the letterforms.
   Points (b) and (c) above stand as originally written, except where
   #51's own text below narrows or extends them further.

51. **18xx-Style Text Background Shield Box, Compact Typography &
   Expanded OO Offset.** Three pieces, closing out the remaining rough
   edges from #50 plus one real bug found in `App.tsx` (not this file --
   see that file's own design note #15 for the nameplate-suppression fix
   itself; this note covers only what changed in this file):

   (a) Tight Text Background Shield Boxes: #50 removed every pixel drawn
   behind a city nameplate on the theory that solid black text directly
   on the hex's own fill would read cleanly on its own. In practice,
   track splines routed directly beneath a nameplate cut through its
   letterforms, especially on busy tiled cities and OO yellow hexes where
   two station circles' connecting curves converge near hex center. Fix:
   `drawHexNameLabel` once again calls `drawLabelWithBackground`, but
   with a new, much tighter footprint than the pre-#50 pill ever had --
   `paddingX`/`paddingY` of 2.5px (vs. the old default's much larger
   pill padding), a new `cornerRadiusPx: 1` override (see (a.1) below),
   and `strokeHalo: false` explicitly, so there is no border stroke and
   no drop shadow, only a flat fill. The box exists purely to occlude
   track geometry behind the letters, not to draw attention to itself.

   (a.1) `drawLabelWithBackground` itself gained one new optional
   parameter to make this possible without duplicating its box-drawing
   logic: `cornerRadiusPx?: number`, defaulting to its prior
   `Math.min(6, boxHeight/2, boxWidth/2)` behavior when omitted. Every
   existing caller (the terrain-cost label, the off-board nameplate)
   omits it and is therefore byte-for-byte unaffected; only the new
   nameplate shield box passes `1`, for a box that reads as essentially
   rectangular rather than pill-shaped.

   (a.2) Fill color: rather than precisely sampling each hex's actual
   computed fill at every call site (fragile, and this function has no
   access to the terrain/color context that far down the call chain),
   two named constants cover the two cases the request itself calls out
   ("match the hex background fill, OR soft pale yellow ... on yellow OO
   hexes"): `NAMEPLATE_BOX_FILL_YELLOW` (`#FEF08A`, the softer of the
   request's two suggested yellows) for every hex that is actually
   printed yellow -- the three landmark hexes and every `YELLOW_OO_HEXES`
   entry -- and `NAMEPLATE_BOX_FILL_DEFAULT` (`#f4ecd8`, chosen close to
   `TERRAIN_FILL.Plain`/`MajorCityHub`) for everything else: the gray/
   `NAMED_HEX_LABELS` single-name pass and the double-town stacked pass,
   neither of which is ever printed yellow. `drawHexNameLabel` takes this
   as a `boxFill` parameter defaulting to the DEFAULT bucket, so the two
   call sites that need YELLOW (landmarks, OO stacked pair) pass it
   explicitly and the two that don't (gray single names, double-town
   stacked pair) simply omit the argument.

   (b) Tight Stacked Line Height & Always-Bold Weight: a new
   `NAMEPLATE_LINE_HEIGHT_PX = NAMEPLATE_FONT_SIZE_PX * 1.05` constant
   (matching the request's literal `lineHeight = 1.05 * fontSize`
   formula) replaces the OLD `hexSize`-relative stacked-line offsets
   (`hexSize * 0.24` for OO pairs, `hexSize * 0.19` for double-town
   pairs, both from #49/#50) with a single `NAMEPLATE_LINE_HEIGHT_PX / 2`
   half-offset used by both passes. This is a deliberate switch from
   zoom-relative to font-size-relative spacing: now that #50 fixed the
   nameplate font at a near-constant 10px regardless of hex size or
   hover, tying line spacing to that same fixed font size (rather than
   to the hex's own radius, which changes with zoom/pan) keeps the two
   stacked lines a constant, tight distance apart on screen at every
   zoom level, instead of drifting wider apart as the board is zoomed
   in. `drawHexNameLabel` also now hard-codes `"bold"` as its font
   weight unconditionally (previously bold only applied on hover per
   #50 point (b)'s "weight is the only remaining hover cue" line) --
   the request's explicit ask for a bold, high-contrast sans-serif
   nameplate applies at all times, not just on hover; hover is left
   with no remaining visual distinction on nameplate text specifically
   (other hover cues elsewhere in this file, e.g. hex outline highlight,
   are untouched).

   (c) Expanded OO Diagonal Offset: `ooCityMarkerOffset`'s magnitude
   widened again, `0.43` (design note #50) -> `0.49`, within the
   requested `~0.48-0.50` range -- see that function's own doc comment
   for the updated safe-distance math (a circle at this offset reaches
   about `0.66 * size` from hex center at its farthest point, still
   inside the `1.0 * size` distance to the hex's own corners). Pushing
   the circles further into their respective corners opens up more
   dead-center clear space for the now-boxed nameplate to sit in without
   visually crowding either circle, which is the point of pairing this
   change with (a) and (b) above rather than doing it in isolation.

   UPDATE (design note #52): every `TILE_CATALOG` entry this note
   references (`0b11_1111`, "all six edges") was a fabricated
   placeholder, not real 1830 data -- see #52's own text for the
   correction and why it's the actual root cause #51's shield box was
   papering over.

52. **Real Tile Data Correction: `TILE_CATALOG` Bitmasks & Two-City
   Rendering.** Root-caused the underlying clutter this file's nameplate
   passes (#47/#49/#50/#51) had been fighting for four passes running:
   every landmark/OO/NY hub tile in `TILE_CATALOG` -- tiles 15-24 -- had
   `connections: 0b11_1111`, meaning `drawTrackPath` drew a spoke from
   ALL SIX hex edges into a shared center on every single one of these
   tiles, regardless of color tier or which of the five OO variants. Real
   1830 tiles never do this; verified against `tobymao/18xx`'s
   `lib/engine/config/tile.rb` (fetched twice independently, byte-
   identical both times) that every one of these tiles has 2-4 live
   edges, not 6:

   - Green "B" (real tile #53, NOT #55 as design note #27 had it --
     #55 turned out to be an unrelated double-town tile with no "B"
     label at all): edges 0, 2, 4.
   - Green "NY" (real tile #54, NOT #57 -- #57 is an unrelated generic
     unlabeled green city tile): edges 0, 1, 2, 3; city A owns 0-1, city
     B owns 2-3.
   - Green "OO" (real tile #59, already correctly cited): edges 0, 2 --
     one per city, each a dead-end stub, not a through-route.
   - Brown "B" (#61): edges 0, 2, 3, 4. Brown "NY" (#62): edges 0, 1, 2,
     3, same city split as Green. Brown "OO" variants (#64-#68): five
     genuinely different 4-edge patterns, each pairing its two cities'
     edges differently -- the whole point of offering five choices.

   `hexmap.rs` module doc comment #28 (backend) covers the Rust side of
   this same correction, including a Yellow-tier restriction fix this
   finding also required. This file's `TILE_CATALOG` mirror is updated
   to the identical corrected bitmasks.

   NEW: `TileCatalogEntry.cityGroups?: readonly (readonly number[])[]` --
   a FRONTEND-ONLY field (deliberately not mirrored to the backend, which
   doesn't need it -- `pathfinding.rs`'s simplified hex-level revenue
   model never distinguishes which edge belongs to which city, only the
   flat union). Set on the six genuine two-city tiles (NY x2, OO x5 -- OO
   Green's `[[0], [2]]` was already effectively two independent
   one-edge stubs even before this, but is now explicit): each entry is
   that city's own live edges. `drawTrackPath`'s 3+-live-edge branch now
   checks for `cityGroups` FIRST -- if present, each city draws its own
   paired-edge curve into its OWN station point (`twoCityStationPoints`,
   a new small helper factoring out the exact offset math the existing
   station-circle placement already used, so track and circles can never
   drift apart), instead of the old behavior of fanning EVERY live edge
   from BOTH cities into one shared hub at hex center -- which was never
   correct for a genuine two-city tile even before the bitmask fix, it
   was just visually indistinguishable from correct while every tile was
   fabricated as a symmetric 6-spoke fan. Single-city tiles (`B`,
   ordinary `MajorCityHub`) have no `cityGroups` and keep the original
   fan-to-center rendering, unchanged.

53. **Strip the #51 Shield Box; Extend Hex Boundary Clipping to Text.**
   Two closing pieces, once #52's real (sparse) bitmasks made the
   original problem #51 was solving mostly go away at the source:

   (a) `drawHexNameLabel` no longer calls `drawLabelWithBackground` at
   all -- back to a single plain `ctx.fillText` in solid `#000000`, no
   box, per this pass's own explicit "strip all giant opaque cream/
   yellow background shield boxes... render city text directly... in
   simple, crisp, solid black" wording. #51's box existed because real
   track was cutting through letterforms -- but with every city/OO/
   landmark tile's connections now genuinely sparse (2-4 edges, not a
   fabricated 6) instead of fanning from every direction, the upper-third
   and dead-center bands these nameplates already sit in are clear of
   track most of the time, so #51 was patching the symptom at the wrong
   layer. `drawLabelWithBackground`/`NAMEPLATE_BOX_FILL_*`/`boxFill` are
   all left in place, unused by `drawHexNameLabel` itself, in case a
   specific still-crowded hex needs a targeted box later -- `boxFill`
   stays a parameter of `drawHexNameLabel` (now ignored, via `void
   boxFill`) so no call site needs its own signature change.

   (b) Hex Boundary Clipping Mask (design note #42's `withHexClip`,
   `ctx.save()`/hex-path/`ctx.clip()`/`ctx.restore()`) previously wrapped
   only track-drawing calls (`drawTrackPath`/`drawLandmarkTrack`/
   `drawOffboardTrack`/`drawPrintedTrack`) -- every `drawHexNameLabel`
   call site (landmark names, gray/OO single names, OO stacked pairs,
   double-town stacked pairs) now gets the identical treatment, so a
   nameplate positioned close to its own hex's edge can never paint text
   into the neighboring hex, regardless of how long the name is or how
   tight `fitFontSize`'s shrink band gets.

54. **High-Contrast Light Shield Boxes (REVERSING #53's box removal) &
   Unified Diagonal Node Geometry.** A follow-up request explicitly asks
   the box back -- #53's own text left `drawLabelWithBackground`/
   `NAMEPLATE_BOX_FILL_*` in place "in case a specific still-crowded hex
   needs a targeted box later"; this is that request, applied uniformly
   rather than to one specific hex. Three parts:

   (a) `drawHexNameLabel` calls `drawLabelWithBackground` again -- a
   TIGHT box (2px padding, 2px corner radius -- genuinely rectangular,
   not #51's soft pill or `drawLabelWithBackground`'s own default
   rounding, and never stroked) rather than #51's slightly looser one.
   `boxFill` (a parameter since #50, ignored by #53's `void boxFill`) is
   live again, but every call site now sources it from the new
   `nameplateBoxFillFor` helper instead of a single hardcoded constant,
   so the box is tier-color-matched: `NAMEPLATE_BOX_FILL_YELLOW`
   (`#FEF08A`) for a Yellow tile or a printed-yellow hex with nothing
   laid yet (landmarks, OO hexes), the new `NAMEPLATE_BOX_FILL_GREEN`
   (`#DCFCE7`) for a laid Green tile, and the new
   `NAMEPLATE_BOX_FILL_SLATE` (`#F1F5F9`) for a laid Brown tile, a real
   GRAY preprinted hex, or any other ordinary (unprinted-color) hex --
   matching the request's own "Brown / Gray / Off-Board Hexes" grouping.
   `NAMEPLATE_BOX_FILL_DEFAULT` (the old flat cream used by the gray/named
   and double-town passes) is retired in favor of the new SLATE constant,
   which those same two passes now resolve to via the helper. Every one
   of this file's FOUR `drawHexNameLabel` call sites is still gated by
   `hexHasLaidTile`'s Dynamic City Nameplate Suppression (#47) -- so in
   practice today only the Yellow and Slate branches are ever reached
   through them (nothing here un-suppresses a post-lay nameplate); the
   Green/laid-tile branch is still fully wired inside the helper itself
   (real tile-color lookup via `TILE_CATALOG_BY_ID`, not a dead literal)
   so the tier system is complete and correct rather than leaving Green
   an unreachable stub.

   (b) Unified Diagonal Node Geometry: the three double-town hexes
   (Akron & Canton G7, Reading & Allentown G17, New Haven & Hartford
   F20) previously used their OWN side-by-side layout (`hexSize * 0.28`
   left-right) for their two dit markers -- visually inconsistent with
   the OO double-city hexes' diagonal top-right/bottom-left circles
   (`ooCityMarkerOffset`). Both now share the exact same helper and
   offset -- `ooCityMarkerOffset`'s magnitude is also tightened from
   #51's `0.49` to this request's own `~0.45`, so EVERY diagonal node
   pair on the board (OO station circles, double-town dit markers, and
   every downstream consumer of the same shared helper --
   `stationMarkerPoint`'s OO anchor, `twoCityStationPoints`'s
   `DoubleCityHub` branch for a laid tile) moves together, never drifting
   apart the way two independently-hand-tuned constants could.

   (c) Compact Stacked Nameplate Centering: the double-town name pass
   moves from the upper-third band (`center.y - hexSize * 0.58 +/-
   lineOffset`, shared with every single-name label) to TRUE HEX CENTER
   (`center.y +/- lineOffset`) -- mirroring design note #49's identical
   repositioning for the OO pass. With the dit markers now diagonal
   (top-right/bottom-left) instead of side-by-side, true center is the
   open channel between them, exactly as it already is for OO.

55. **Universal Canvas Layout Engine.** Replaces every remaining one-off,
   per-hex-identity placement branch with a single shared system driven
   entirely by TILE/TERRAIN DATA -- see the big block comment right above
   `archetypeForHex` (search "UNIVERSAL CANVAS LAYOUT ENGINE") for the
   full design; this entry is the top-of-file index pointer. Four parts:

   (a) `HexArchetype` + `archetypeForHex`/`archetypeForTerrain`: classifies
   ANY hex into SingleCity/DoubleCity/SingleTown/DoubleTown/Plain purely
   from structural data (a laid tile's real terrain, or an un-laid hex's
   OO/town-designation/city-designation/GRAY-marker/landmark-track-segment-
   count) -- never a name/label string. REMOVES the one remaining literal
   identity check in the file, `stationMarkerPoint`'s `hex.label ===
   "G19"`, replacing it with "is this a landmark whose OWN
   `LANDMARK_TRACKS` data has two real stub segments" (New York today, any
   future same-shaped landmark automatically tomorrow). Also removes
   `landmark.name === "Boston"/"New York"/"Baltimore"` from the
   restriction-badge loop -- badge text ("B" vs "NY") is now read off the
   SAME archetype classification, not a separate name comparison.

   (b) Shared placement formulas: `doubleNodeOffset` (renamed/updated from
   #54's `ooCityMarkerOffset`, now the request's own explicit `(+0.43 * R,
   -0.25 * R)` top-right/bottom-left coefficients) for every two-node hex
   with no real anchoring track of its own (OO, double-town, a laid
   `DoubleCityHub` tile); `singleNodeNameplateAnchor` (`(x: -0.25 * R, y:
   -0.35 * R)`, the request's own Upper-Left wedge) for every one-node hex
   (landmarks' SingleCity case, gray/white single cities, single towns).
   New York -- a DoubleCity landmark with REAL printed stub track -- keeps
   its own authentic edge-anchored station geometry (`drawLandmarkTrack`)
   rather than being forced onto the generic floating formula (moving a
   station circle off the end of its own real rail would be a visual
   regression, not an improvement), but its NAMEPLATE now uses the shared
   DoubleCity dead-center anchor and "A & B" stacking rule exactly like
   every other DoubleCity hex, dropping out of its old special-cased
   single-name treatment.

   (c) Strict Z-order: the one out-of-order pass (terrain build-cost
   labels, previously drawn as pass #2 -- Layer 4 text content drawn
   before ANY Layer 2/3 content) is split from its Layer 1 terrain icon
   and moved down into the Layer 4 section, after every station/token
   pass, alongside the other badges.

   (d) Universal shield boxes + clipping: restriction badges ("B"/"NY"/
   "OO", previously bare unframed text) and terrain cost labels
   (previously a generic translucent-white box) now get the SAME tight
   (2px padding, 2px corner radius, no stroke), tier-color-matched shield
   box (`nameplateBoxFillFor`) every nameplate already has; the off-board
   zone nameplate switches from a dark plate + light-pink halo text to the
   same light SLATE box + solid black text. `withHexClip` (design note
   #42) is extended to every remaining unclipped hex-rendering call this
   pass touched (OO/town/city station markers, station token markers,
   value badges, off-board nameplates) -- REMAINING SCOPED EXCEPTIONS,
   documented at their own call sites rather than silently glossed over:
   the Gulf/Canadian West MERGED nameplate (spans two real hexes by
   design, so a single-hex clip would incorrectly bisect it) stays
   unclipped, and city/town value badges keep their existing circular
   high-contrast badge treatment (colored fill + dark stroke + white halo
   text) rather than being redrawn as rectangles -- already a
   high-contrast, tightly-bounded, board-tested design in its own right,
   and out of this pass's scope to redesign wholesale.

56. **G19 Station Node Index Inversion Fix.** Reported via screenshot:
   NYNH's (company 7/"NNH") home token rendered on G19's Bottom-Left/SW
   circle instead of its canonical Top-Right/NE one. Root cause: #55's
   rewrite of `stationMarkerPoint`'s landmark branch (removing the old
   `hex.label === "G19"` check) anchored on `landmarkSegments[1]` -- the
   SECOND/SW segment -- unconditionally, instead of the FIRST/NE segment
   that the canonical "Node Index 0 = Top-Right/NE" rule requires. Fixed
   by (a) anchoring `stationMarkerPoint`'s landmark branch on the exact
   same literal `doubleNodeOffset` top-right point every other
   `DoubleCity` hex uses, rather than any edge-derived approximation of
   it; (b) rewriting `drawLandmarkTrack`'s one-edge-segment stub-station
   formula to target that SAME canonical point, indexed by segment order
   (segment 0 = Node 0 = NE, segment 1 = Node 1 = SW), so the real
   printed track's own station circle and the corporate token marker can
   never drift apart pixel-for-pixel; (c) merging `twoCityStationPoints`'s
   stale, non-diagonal `NewYorkHub` left/right formula into the same
   branch as `DoubleCityHub`, since both terrains now resolve to
   identical Node 0/Node 1 coordinates. Every 2-station archetype (G19,
   the four OO hexes, every double-town) now shares one literal formula
   and one Node 0(NE)/Node 1(SW) convention, with no hex-name branching
   anywhere in the chain. OO and double-town node order were already
   correct under #55 and are unchanged by this fix.

57. **Laid Double-Town Tile Dit-Marker Standardization.** Coordinate-only
   sweep to find and fix any remaining double-node call site not yet on
   the shared diagonal formula: found one -- a laid `DoubleTown` tile #6's
   OWN dit-marker pass (distinct from the unlaid `townDesignation:
   "double"` marker pass #55 already fixed) still used an independently
   computed, non-diagonal `size * 0.28` left/right pair. Fixed to use the
   same shared coordinates as G19/OO/every other double-node hex. No
   other outliers found; every double-node call site was audited.

58. **Single Shared 2-Node Coordinate Helper (`twoNodePositions`).**
   Generalizes #56's G19 fix so the same class of bug (a call site
   hand-deriving `center ± offset` and getting the sign wrong) can't
   recur anywhere else. Adds ONE function, `twoNodePositions(center,
   size)`, returning `[node0, node1]` -- index 0 always Top-Right/NE,
   index 1 always Bottom-Left/SW -- built on top of `doubleNodeOffset`'s
   existing `(+0.43 * R, -0.25 * R)` delta. Every double-city/double-town
   call site (`stationMarkerPoint`'s OO and landmark branches,
   `drawLandmarkTrack`'s stub-station branch indexed by `segmentIndex`,
   `twoCityStationPoints`, `drawOOCityMarkers`, both the unlaid
   `townDesignation: "double"` dit pass and the laid `DoubleTown` tile
   dit pass) now calls this ONE function and indexes into its tuple by
   its own already-existing city/segment/node index, rather than
   re-deriving the `+`/`-` arithmetic locally at each site. Purely a
   coordinate-plumbing change -- no dispatch condition (which hexes/tiles
   count as "two-node") was altered, so every existing structural,
   non-hardcoded classification (`HexArchetype`, `cityGroups.length`,
   `LANDMARK_TRACKS` segment count, `townDesignation`) is unchanged.

59. **Lightweight Solid Black Dot Small-Town Primitive.** Primitive-
   styling-only pass over `drawDitMarker` (the one function every small-
   town/dit marker in the file draws through -- laid `SmallTown`/
   `DoubleTown` tiles, pre-printed gray-hex towns, unlaid
   `townDesignation` markers): fill changed from a near-black `#141414`
   to a literal solid `#000000`, its `#d8d8d8` ring stroke removed
   entirely (no border/outline/station-container styling of any kind),
   and its radius shrunk from `size * 0.14` to `size * 0.08` -- about 36%
   of `drawStationCircle`'s own `size * 0.22` city-circle radius, inside
   the requested 30-40% band (later tuned up +40% to `size * 0.112` by
   design note #60, a follow-up visual-feedback pass). Every call site's
   own point/size arguments
   (including the double-town `size * 0.85` scale-down and the diagonal
   `twoNodePositions` coordinates feeding them) are UNCHANGED -- this
   pass touched only what happens inside `drawDitMarker` itself, not
   where or how large a scale factor calls it with; city station
   circles, track spline routing, and all node-position math are
   untouched.

60. **Small-Town Dot Size Follow-Up (+40%).** Visual-feedback pass after
   seeing #59's `size * 0.08` dots rendered live -- reported as a bit too
   small. Bumped to `size * 0.112` (`0.08 * 1.4`), still comfortably
   smaller than `drawStationCircle`'s `size * 0.22` city circle (~51% of
   it) so towns stay visually distinct from stations. Radius-only change,
   same `#000000` fill, no stroke, no other call site touched.

61. **Small-Town Dot Size Follow-Up #2 (`size * 0.14`).** Still too small
   at #60's `size * 0.112` -- bumped again, this time to an explicit
   `size * 0.14` (~64% of `drawStationCircle`'s `size * 0.22`), the exact
   radius MAGNITUDE `drawDitMarker` used before #59's rewrite (that
   earlier version paired it with a `#141414` fill and a `#d8d8d8` ring
   stroke; #59 already removed both, unchanged here). Still visibly
   smaller than a city station circle. Radius-only change, same
   `#000000` fill, no stroke, no other call site touched.

62. **Shape-Based Revenue Badge Iconography.** Replaces every
   color-coded revenue-value badge fill on the board with one uniform
   solid white (`#FFFFFF`) fill + `#1E293B` dark-navy stroke
   (`lineWidth = 1.5`), carrying the city-vs-town distinction that color
   used to encode via SHAPE instead: `drawValueBadge`'s badges (every
   landmark, gray-hex city/town, yellow-OO hex, and laid SmallTown/
   DoubleTown/MajorCityHub/DoubleCityHub tile) now render as a SQUARE for
   MajorCityHub/DoubleCityHub and a DIAMOND for SmallTown/DoubleTown, via
   the new `VALUE_BADGE_SHAPE` map (replacing `VALUE_BADGE_COLOR`); the
   off-board zone revenue badge (`drawOffboardNameplate`'s own circular,
   era-color-tier-coded badge) is now the SAME white SQUARE style,
   grouped with city revenue per this pass's own explicit rule. Every
   badge's number now renders in plain, unbolded (`font-weight: normal`)
   solid black (`#000000`) text via a direct `ctx.fillText` -- no
   dark-halo `fillTextWithHalo` stroke (that was contrast help for white
   text on a variable-colored fill; black-on-white already has full
   contrast on its own). The board's full shape-based iconography is now:
   white circles = city stations, small solid-black dots = towns
   (design note #59), white squares = city/off-board revenue, white
   diamonds = town revenue. `drawBadgeShape`'s square is sized
   (`radius * Math.SQRT1_2` half-side) so its own farthest corner sits at
   exactly the same `radius` distance from center the old circle (and
   the new diamond) reached, so none of `drawValueBadge`'s existing
   corner-placement/hex-boundary-bleed-safety math needed to change.
   Scope-limited to badge primitives only: badge center/corner-placement
   logic, station circle rendering, track spline routing, and every
   other text-placement calculation are untouched.

63. **Text-Driven Revenue Badge Sizing + Bold Text.** Reported: #62's
   badges were too small and clipped their own numbers. Root cause was
   the OLD sizing relationship, inherited unchanged from long before #62:
   a fixed badge radius (`Math.max(6, size * 0.18)` for `drawValueBadge`,
   `Math.max(7, hexSize * 0.24)` for the off-board badge) with the FONT
   shrunk (via `fitFontSize`, down to a 5px floor) to whatever fit inside
   it -- fine for a single-color pill where the exact radius didn't
   matter much, but on the new white shapes a long value could shrink to
   the point of crowding/clipping against the shape's own edge. Inverted
   the relationship (design note #62's own doc comment already flagged
   this as worth revisiting): both badges now fix a bold font first
   (`Math.max(9, size * 0.2)` / `Math.max(9, hexSize * 0.24)`, never
   shrunk) and size the badge SHAPE around the actual measured text via
   the new `badgeRadiusForLabel` helper (mirroring the same "measure
   text, size the box around it" approach `drawLabelWithBackground`
   already uses for nameplate shield boxes elsewhere in this file), with
   a floor at the old fixed radius so short values never shrink the
   badge below its previous minimum size. Text also switched from plain
   (`font-weight: normal`, #62's own choice) to BOLD, per this pass's
   explicit request. Scope unchanged from #62: badge shapes/positions
   and revenue-badge text only -- station circles, track splines, and
   every other text-placement calculation in the file are untouched.

64. **Revenue Badge Tightening (-1pt Font, Tight Padding).** Reported:
   #63's badges swung too far the other way -- too large, with visible
   slack inside the shape. Two compounding causes, both fixed: (a) the
   `badgeRadiusForLabel` floor (`Math.max(6, size * 0.18)` /
   `Math.max(7, hexSize * 0.24)`) was still the OLD fixed-badge-era
   radius, so it silently won out over the (smaller) text-fit
   calculation for every ordinary 2-digit `$10`/`$20`/`$40` value --
   dropped to a small flat `5` safety floor, letting the actual measured
   text drive the size as originally intended; (b) padding was a
   generous `4`/`3` -- tightened to this file's own established `2`/`1.5`
   "tight shield box" convention. Font size also dropped 1pt (`- 1` off
   each of `drawValueBadge`'s and the off-board badge's own font-size
   formula), per this pass's explicit request. Same scope as #62/#63:
   badge shape/size/text only.

65. **All-Square Revenue Badges + Another -1pt.** Reported: town
   diamonds still took up too much room. Root cause is structural, not a
   tunable constant -- `badgeRadiusForLabel`'s own doc comment derives
   that a diamond needs radius `halfWidth + halfHeight` to clear a text
   corner (its boundary tapers away from center on every side), while a
   square only needs `max(halfWidth, halfHeight)`/`Math.SQRT1_2` -- a
   diamond is inherently the larger shape for the same text, no amount
   of padding/floor tuning fixes that. `VALUE_BADGE_SHAPE` now maps
   every terrain (`SmallTown`/`DoubleTown` included) to `"square"`; the
   board's iconography simplifies to white circles = city stations,
   small black dots = towns, white squares = every revenue badge.
   `drawBadgeShape`/`badgeRadiusForLabel` still support `"diamond"` as a
   valid option (unused, not deleted). Font size also dropped ANOTHER
   1pt (`- 2` off each font-size formula now, cumulative with #64) on
   both `drawValueBadge` and the off-board badge. Same scope as
   #62/#63/#64: badge shape/size/text only.

66. **Drop `$` Prefix, +1pt Font.** Both `drawValueBadge`'s `label` and
   the off-board badge's `activeValue` now print the bare number
   (`${value}`) instead of `$${value}` -- the white square shape already
   unambiguously reads as a revenue badge on its own (#62's board-wide
   shape iconography), so the symbol was redundant, and dropping it
   leaves more of the tightly-fit square for the digits. Font size
   bumped back up 1pt on both badges (`- 1` instead of #65's `- 2`, so
   now -1pt net off the original #63 baseline, not -2pt). Same scope as
   #62-#65: badge shape/size/text only.

67. **Scroll-Wheel Zoom Disabled.** `handleWheel`'s zoom-around-cursor
   logic (the `setView`/`clampPanToBoard` update, identical math to the
   "+"/"-" camera buttons) is REMOVED -- reported: manual buttons should
   be the ONLY way to zoom, not an incidental scroll gesture over the
   map. `handleWheel` now only calls `event.preventDefault()`, kept
   unconditional and unchanged in purpose from design note #13 (stops
   the page itself from scrolling while the cursor is over the canvas --
   a scroll-containment concern, separate from zoom). The "+"/"-" button
   handlers and every other zoom/pan path are untouched.

68. **Terrain Cost Badges Recolored Red/White, -1pt.** Reported: terrain
   build-cost labels (Mountain/River hexes) needed to read as distinct
   from revenue badges. The terrain-cost pass draws through
   `drawLabelWithBackground` (a rounded-rect shield box), a different
   primitive from `drawValueBadge`'s square/diamond `drawBadgeShape`
   (#62-#66) -- already a different SHAPE, now also a different COLOR:
   solid red (`#E53E3E`, this file's own established "crisp" red from
   `drawImpassableBorderEdge`/design note #42, reused rather than a new
   hex value) box with white (`#FFFFFF`) text, replacing the old
   tier-colored box (`nameplateBoxFillFor`) with black text every other
   board text element still uses. Font base size dropped 1pt (`9`
   instead of `10`) in `fitFontSize`'s call. Scope-limited to this one
   label pass -- every other `drawLabelWithBackground` caller
   (nameplates, off-board names) keeps its existing tier-colored
   styling untouched.

69. **Restriction Badges: Background Removed, Un-Bolded, +1pt.**
   Reported: the "B"/"NY"/"OO" tile-upgrade-restriction badges' own
   tier-colored shield box (added by #55, reversing #49's original
   "no background" call) made them look like they sat on a separate
   plate rather than being printed directly on the hex/tile -- unlike a
   real 1830 tile's own restriction lettering, which is plain ink on the
   printed tile face with no box. `drawRestrictionBadge` now calls
   `drawLabelWithBackground` with `background: false` (the same
   no-box escape hatch `drawBoardMarginLabels` already used), dropping
   its now-unused `boxFill` parameter (and both call sites' own
   `nameplateBoxFillFor` lookups, no longer needed) entirely rather than
   leaving dead plumbing behind. Text also un-bolded (`"bold"` ->
   no weight override) and sized up 1pt (base/min `10`/`7` -> `11`/`8`),
   per this pass's explicit request. Every other badge type in the file
   (revenue badges, terrain cost labels, nameplates) keeps its own
   existing shield-box/bold/size treatment untouched.

70. **13-Slot Pointy-Topped Perimeter Anchor System.** Reported: replace
   the file's various ad-hoc "vertical thirds"/fixed-corner positioning
   literals with one shared, geometry-driven layout engine. Requirement
   1 (confirm pointy-topped hex baseline) needed NO code change -- hand
   verified `pointOnCircle`/`edgeAngleRad`/`cornerAngleRad` already
   produce a vertex at true top/bottom (corners 2/5) and vertical edges
   left/right (edges 0/3), i.e. already pointy-topped from the start.
   Added a new 13-slot coordinate system (`hexSlotPoint`,
   `hexSlotDirection`, slot 0 = center, slots 1-6 = edge midpoints,
   slots 7-12 = corner vertices, in the requirement's own stated
   compass order) plus occupancy helpers (`liveEdgesForHex`,
   `hexBlockedSlots`, `slotsBlockedByEdges`, `pickHexSlot`) that mark a
   slot BLOCKED when a track spline/station passes through it and pick
   the first OPEN slot from a caller's own preference list, falling back
   through progressively looser tiers exactly the way the pre-existing
   `BADGE_CORNERS`/`drawValueBadge` tiered search already did (validated
   by hand against all 4 of that search's `guardEdges` entries before
   generalizing it). Four consumers now run through this shared engine
   instead of their own private literals: `singleNodeNameplateAnchor`
   (was a single fixed offset, now slot-12/upper-left first with a real
   fallback -- special-cased to return the byte-identical old vector at
   slot 12 itself, so the overwhelmingly common unblocked case is
   pixel-identical to before), `drawValueBadge` (was `BADGE_CORNERS`,
   now `BADGE_SLOT_PREFERENCE` -- same four corners, same tier order,
   same `0.44 * size` magnitude, but now the true corner ANGLE rather
   than a fixed 45-degree diagonal), `drawRestrictionBadge` (was a fixed
   literal `cornerIndex`, now archetype-keyed preference lists with a
   real fallback for the first time), and the terrain build-cost label
   loop (was a fixed lower-third/bottom-right-quadrant literal, now
   slot-10/bottom-point first for the default case -- byte-identical
   direction to the old fixed vertical offset -- and slot-3/SE-edge
   first for OO hexes). Scope constraint honored: `doubleNodeOffset`,
   `twoNodePositions`, and every station-node coordinate are untouched.
   HONEST GAP, flagged rather than silently worked around: Requirement
   4 also asks to anchor "Tile IDs" clear of track -- this board does
   not currently render a tile catalog ID number anywhere on a laid hex
   (the only on-screen `tileId` text is an unrelated tile-picker preview
   swatch); the terrain-cost label above is the closest existing
   "bottom vertex / lower edge margin" element and was refactored
   against that requirement instead, and the new engine is generic
   enough to anchor a real on-board tile-ID label the same way if one is
   added later.

71. **G19 (New York) Reclassified as a Real River Hex.** Reported, with a
   reference screenshot of the real 18xx.games G19 tile: New York's own
   printed hex carries a water icon and an "$80" terrain build cost this
   file never rendered, because `STATIC_BOARD_HEXES`' G19 entry was typed
   `"Plain"`. VERIFIED against this file's own established source
   (design note #6: `tobymao/18xx`'s `lib/engine/game/g_1830/map.rb`)
   before changing anything, per this file's standing "never guess,
   cross-check the real source" rule: G19's real HEXES entry reads
   `'city=revenue:40;city=revenue:40;path=a:3,b:_0;path=a:0,b:_1;
   label=NY;upgrade=cost:80,terrain:water'` -- `terrain:water`/`cost:80`
   confirms the screenshot exactly, and matches this file's own existing
   `TERRAIN_BUILD_COST_LABEL.River = "$80"` constant precisely (no new
   figure invented). Fixed by changing G19's `type` from `"Plain"` to
   `"River"`, alongside its existing `printedColor: "Yellow"` -- the
   EXACT SAME field combination `YELLOW_OO_HEXES`' own two real river
   hexes (D10/Hamilton & Toronto, E5/Detroit & Windsor) already use (see
   `YELLOW_OO_HEXES`'s own doc comment), so this isn't a new code path,
   just G19 correctly joining an already-proven one.

   KNOCK-ON FIX, required for correctness, not just requested: the
   terrain-icon and terrain-cost-label passes both used to gate their
   off-center "clear of the two station circles/nameplate" positioning on
   `YELLOW_OO_HEXES.has(hex.label)` specifically -- a NAME-keyed check
   that would have silently centered a full-size river icon directly on
   top of G19's own two NNH/landmark station circles and nameplate the
   moment G19 became a River hex, since G19 was never in that OO-only
   set. Generalized both checks to `archetypeForHex(mapGrid, hex.q,
   hex.r) === "DoubleCity"` instead -- the STRUCTURAL condition the old
   OO-specific one was really standing in for all along (this file's own
   established "no hex-name-literal branching on where to draw" rule,
   design note #53) -- so G19 now automatically gets the identical
   off-center icon/label treatment the two OO rivers already do, no
   G19-specific literal added anywhere.

   CROSS-CHECKED against the reference screenshot's own Vertex/Edge
   numbering (screen-relative, clockwise from the true top vertex): the
   13-slot engine (design note #70) already resolves G19's revenue
   badges to its Vertex 1/Vertex 4 corners and its "NY" restriction badge
   to its Vertex 5 corner, all matching the reference, purely as a
   consequence of G19's own two live stub-track edges (`LANDMARK_TRACKS`
   edges 1/NE and 4/SW) blocking the other four corner slots -- no
   G19-specific code exists for any of those either. HONEST CAVEAT: the
   reference places the water icon/cost right at Vertex 2 itself; the
   generalized engine (preference `[3, 9, 10, 11]`) lands G19's own
   instance one slot over, on the adjacent SE edge midpoint (slot 3),
   since Vertex 2 itself (slot 9) is NOT actually blocked here but sits
   later in that same shared preference list used by the two OO rivers
   too -- visually in the same corner/quadrant, not pixel-identical to
   the reference's exact vertex, and not special-cased further to avoid
   reintroducing a hex-specific literal for one pixel of precision.

72. **Cross-Pass Slot Claiming.** Reported via screenshot, AFTER #70/#71:
   on New York (G19), the revenue badge, the terrain-cost label, and the
   terrain icon still rendered stacked on top of each other. Root cause:
   every slot-picking pass (terrain icon, restriction badge, terrain-cost
   label, revenue badge) called `pickHexSlot` independently, each blind
   to what any OTHER pass had already drawn on the SAME hex -- harmless
   everywhere no two passes' own short preference lists ever favored the
   same slot, but G19's two real stub track edges block four of its six
   corners, leaving only two open, and three separate passes all
   independently picked the SAME one. Fixed with `claimHexSlot`, ONE
   `Map<"q,r", Set<slot>>` ledger (`claimedHexSlots`) created fresh at
   the top of this whole block of passes and threaded through all four,
   in their existing draw order (icon, restriction, cost, badge): each
   call unions its own hex's already-claimed slots into what counts as
   "blocked" before picking, then records its own pick so the next pass
   on that hex avoids it too. Paired with a new `extendSlotPreference`
   helper so a pass whose own short list (e.g. `BADGE_SLOT_PREFERENCE`'s
   four corners) is entirely taken by live track and prior claims falls
   through to any OTHER open slot on the hex (a `CORNER_SLOTS`-only pool
   for `drawRestrictionBadge`, which has no edge-slot rendering path;
   every slot for everything else) instead of the old tier-4 "first
   candidate anyway" landing back on top of live track or another label.
   The terrain icon's own DoubleCity positioning (previously design note
   #71's fixed `{0.36, 0.32}` literal offset) is now ALSO slot-driven
   through this same ledger, sharing `DOUBLE_CITY_TERRAIN_SLOT_PREFERENCE`
   with the terrain-cost label so the two stay paired when both are free
   to take their shared first choice. A hex with only one or two of
   these four features (the overwhelming majority of the board) is
   completely unaffected -- `claimedHexSlots` starts empty for every hex,
   so only a genuinely crowded landmark hex like G19 ever reaches a
   fallback slot at all.

73. **Two-Node Offset: Edge Midpoints, Not a Diagonal.** Explicit
   instruction, after #55's original diagonal offset was shown (by the
   same G19 reference screenshot #71 verified against) to land almost
   exactly ON a hex vertex (`(+0.43, -0.25)` resolves to -30.17 degrees,
   0.17 degrees off `cornerAngleRad(1)` exactly) instead of an edge
   midpoint the way the real board prints it: "scrap the earlier offset
   rules... instead set them so that one city/town marker is at (what I
   call) Edge 0 and the other is at Edge 3." `doubleNodeOffset` REPLACED
   WHOLESALE -- no longer a hand-picked `(+0.43, -0.25)` diagonal
   coefficient pair, now `pointOnCircle` along this file's own edge 1 (NE,
   the user's own "Edge 0") at a magnitude pulled in from the true
   apothem (`size * sqrt(3)/2`) by the station circle's own `size * 0.22`
   radius (`drawStationCircle`) plus a visible safety margin, so the
   circle never bleeds past the hex's printed border the way a
   full-apothem placement would. Edge 4 (SW, the user's own "Edge 3") is
   exactly opposite edge 1 (180 degrees apart), so `twoNodePositions`'
   existing `center + delta`/`center - delta` structure (design note #58)
   needed NO changes at all -- only the delta vector itself did. BOARD-
   WIDE by construction, same as every prior pass touching this function:
   every double-node hex (New York, all five OO `DoubleCityHub` variants,
   every double-town) moves together, since none of them compute their
   own offset independently.

74. **Nameplates Join Cross-Pass Slot Claiming; Bottom-Vertex Fallback
   Promoted.** Reported via screenshot (Baltimore/I15: nameplate, "B"
   restriction badge, and revenue badge all overlapping) that #72's
   cross-pass claiming ledger didn't actually fix every collision --
   root cause: `singleNodeNameplateAnchor` was never migrated off the
   raw `pickHexSlot` call, so it stayed completely invisible to (and
   unaware of) every OTHER pass's claims. Concretely, on Baltimore
   (real printed edge-0/edge-4 through-route), BOTH the nameplate's own
   `NAMEPLATE_SLOT_PREFERENCE` and the restriction badge's
   `RESTRICTION_SLOT_PREFERENCE_OTHER` independently resolved to the
   SAME upper-left corner (the one corner Baltimore's track leaves open),
   landing exactly on top of each other -- `claimHexSlot` alone can't
   prevent that when one of the competing passes never calls it. Fixed:
   `singleNodeNameplateAnchor` now takes the same `claimedHexSlots`
   ledger every other pass does and calls `claimHexSlot`, and both of
   its call sites (the landmark SingleCity pass, the gray/named-hex
   pass) now pass it through -- nameplates are the FIRST of these passes
   to run each render, so the common case (nothing else competing for
   upper-left) is unaffected, exactly as before.

   SEPARATELY, reported: Fall River (F24) and Atlantic City (I19) --
   real gray connector hexes with track fanning out in several
   directions -- had their nameplates landing on top of a track spline
   despite not being "blocked" by the letter of the rule, because
   `NAMEPLATE_SLOT_PREFERENCE`'s old order tried all six EDGE slots
   (each one sitting where a spline actually runs) before ever reaching
   the bottom vertex, a perfectly good corner it treated as almost a
   last resort. Reordered to try the bottom vertex (slot 10) SECOND,
   right after the default upper-left, per the user's own explicit
   suggestion -- a busy hex with every upper corner blocked now lands
   there instead of on an edge.

75. **Adaptive Quadrant for the Coordinate Hover Tooltip.** Reported: the
   off-board hover tooltip (`drawOffboardTooltip`, design note #15/item 4)
   already flips toward whichever quadrant has room, but this file's
   OTHER tooltip -- the DOM `position: fixed` "{label}: {name} (Value:
   $X)" card that follows the cursor over every hex, board-wide (design
   note #21) -- always anchored `clientX + 14`/`clientY + 14`, sitting
   down-right of the cursor unconditionally, so it ran past the panel's
   own edge for any hex near the panel's right or bottom side (Boston,
   Fall River). `handlePointerMove` now also computes `preferLeft`/
   `preferAbove` from the cursor's position within the CANVAS's own
   bounding rect (already computed there for the hex hit-test, so this
   is free) relative to its own midpoint -- not the browser window's,
   so the flip threshold tracks the panel's actual edges even if the
   canvas doesn't fill the full viewport. The tooltip's JSX then swaps
   `left`/`top` for `right`/`bottom` (both still viewport-anchored,
   `position: fixed`) on whichever axis needs to flip, so the corner
   nearest the cursor is always the one INSIDE the panel.

76. **Far-Side Fallback for Badge/Restriction on Crowded DoubleCity Hexes.**
   Reported, still on G19 after #72/#74's claiming fixes: the revenue
   badge, terrain-cost label, and terrain icon rendered at three
   mathematically DISTINCT slots (verified) but still read as visually
   stacked. Root cause, one level deeper than #72: G19's own two live
   stub edges leave only two open corners (9, 12) and four open edges (2,
   3, 5, 6) -- so once the terrain icon and terrain-cost label claim two
   of those (their own shared near-side preference, `[3, 9, 10, 11]`,
   unchanged), the revenue badge's own four corner preferences are ALL
   either live-track-blocked or already claimed, and it fell through to
   `extendSlotPreference`'s purely neutral ascending fallback -- which
   handed back slot 2 (0 degrees), immediately adjacent to the icon/cost
   pair it was trying to avoid (30/60 degrees). `BADGE_SLOT_PREFERENCE`
   and `RESTRICTION_SLOT_PREFERENCE_DOUBLE_CITY` now each list the two
   FAR-side edge slots (6/NW, 5/W -- 180/240 degrees, the opposite side of
   the hex from the icon/cost cluster) as an explicit early fallback,
   ahead of the neutral tail. Common case unaffected (badge/restriction
   both still take their own first-preference corner whenever it's open,
   exactly as before); only a hex this crowded ever reaches the new far-
   side entries, and now lands genuinely clear of the icon/cost pair
   instead of merely technically-unclaimed.

77. **Two-Node Offset Pulled In Further, size*0.58 -> size*0.50.** Reported:
   after #73 moved station circles onto their edge midpoints, the real
   track stub connecting the hex's edge to the station -- the visible
   proof of a valid route connection -- was nearly invisible, squeezed
   into a bare `0.066 * size` gap between the `0.58`-magnitude circle and
   the `0.866 * size` apothem boundary. Pulled in to `size * 0.50`
   (`0.146 * size` clearance, over double), a "very small amount" per the
   request's own framing -- direction unchanged, only the distance from
   center. Board-wide by construction, same as #73: every double-node
   hex moves together.

78. **Nameplate Typography/Shield Standardization, Off-Board Combined
   Nameplate+Revenue Block, G19 Display Name.** Explicit scope constraint
   honored: the 13-slot placement algorithm itself (WHICH slot a
   nameplate/badge/icon claims) is UNCHANGED by this pass -- every edit
   below is typography/fill/grouping only, layered on top of whatever
   anchor point the existing #70/#72/#74/#76 slot-claiming system already
   picked.
   (a) `drawHexNameLabel`'s tier-color-matched shield box
   (`nameplateBoxFillFor`/`NAMEPLATE_BOX_FILL_YELLOW`/`_GREEN`/`_SLATE`,
   #54) is REPLACED by a single flat semi-transparent white
   (`rgba(255, 255, 255, 0.75)`), going fully opaque
   (`rgba(255, 255, 255, 1.0)`) on hover -- the `boxFill` parameter is
   dropped from every call site since the fill no longer varies by tile
   color/tier. `nameplateBoxFillFor` and the three `NAMEPLATE_BOX_FILL_*`
   constants are left defined (dead code) rather than deleted, to keep
   this diff purely additive/subtractive at the call sites instead of
   touching unrelated plumbing.
   (b) Font weight for every nameplate (landmark, gray/named hex, OO/
   double-town stacked halves, off-board zone names) drops from always-
   bold (#51) to REGULAR -- `fitFontSize`'s `fontWeight` argument changes
   from `"bold"` to `""` at every nameplate call site. `NAMEPLATE_FONT_SIZE_PX`/
   `_MIN_PX` move from 10/8 to 11/9, and the off-board nameplate's own
   previously-independent 10/6 literals are replaced with the same two
   shared constants, so EVERY nameplate on the board (on-board and off-
   board alike) now renders at one uniform crisp scale instead of two
   slightly different ones. Revenue/terrain-cost BADGE text (a distinct
   element from a nameplate, per this file's own long-standing square/
   diamond badge-shape iconography) is deliberately left bold -- out of
   this pass's "nameplates" scope.
   (c) `drawOffboardNameplate` (the red off-board zone name + revenue
   pass) is rewritten from two independently hex-relative-offset pieces
   (name pinned `hexSize * 0.42` above center, badge pinned `hexSize *
   0.44` below, regardless of how many name lines there were) into one
   combined block: total block height is computed from the ACTUAL name
   line count plus the badge's own measured diameter, then the whole
   block is centered so its own vertical midpoint lands exactly on the
   hex's center -- the badge sits immediately beneath the name text
   (small proportional gap, `hexSize * 0.08`) rather than at a fixed
   hex-relative offset that happened to look adjacent only for the
   common one-line-name case. Falls back to badge-only, centered exactly
   on the hex, when `showCityNames` is off (no name lines to combine
   with). Also picked up the new white translucent shield box from (a),
   replacing its own previous `NAMEPLATE_BOX_FILL_SLATE`.
   (d) G19's nameplate now reads "New York & Newark" (was "New York"),
   matching the physical tile and triggering the SAME stacked-two-line
   " & " format the OO/double-town passes already use -- via a new
   optional `LANDMARK_HEXES.displayName` field, so `LANDMARK_TRACKS`
   and every other lookup keyed on the landmark's real, unchanged
   `.name` ("New York") stays exactly as it was.

79. **Single-Node Nameplate Wrap-Not-Shrink (follow-up to #78).**
   Reported: Lancaster, Atlantic City, Fall River, Columbus, Baltimore,
   Washington D.C., Rochester, Kingston, Cleveland, and Providence
   rendered visibly SMALLER than every other nameplate -- #78's own
   "one uniform size" standardization wasn't actually uniform, because
   the single-node nameplate pass (every gray/named hex, plus Boston/
   Baltimore) still ran each name through `fitFontSize`'s per-name
   shrink-to-fit against a tight `hexFlatWidth * 0.55` budget: short
   names (Boston, Toledo, Albany, ...) fit at the full
   `NAMEPLATE_FONT_SIZE_PX` untouched, longer ones didn't and silently
   shrank toward `NAMEPLATE_FONT_MIN_PX` instead. New `drawSingleNodeNameplate`
   wraps a multi-word name onto two stacked lines (same first-space
   split the OO/double-town/off-board passes already use) around the
   SAME anchor `singleNodeNameplateAnchor` picked, rather than shrinking
   it onto one; a single-word name with no space to wrap at instead gets
   a much wider budget (`hexFlatWidth * 0.92`, matching the off-board
   pass's own value) so it no longer needs to shrink either. Purely a
   text-layout change at an already-chosen anchor point -- does not
   touch the 13-slot placement/claiming system.

80. **Nameplate Font Size -4pt.** Reported too large at #78's 11/9 --
   `NAMEPLATE_FONT_SIZE_PX`/`_MIN_PX` dropped to 7/5, same shared
   constants every nameplate (on-board and off-board) still draws from.

81. **Nameplate Font Size, Try 8pt.** #80's 7/5 tried next size up, per
   direct request -- 8/6, same shared constants.

82. **Nameplate Shield +20% Transparency.** `NAMEPLATE_SHIELD_FILL`
   dropped from `rgba(255,255,255,0.75)` to `rgba(255,255,255,0.55)`,
   per direct request -- hover fill unchanged (still fully opaque).

83. **Nameplate Wrap Rule: Ampersand Only, Plus One Named Exception.**
   Per explicit rule: a nameplate wraps onto two stacked lines ONLY when
   it names two separate cities via an ampersand ("A & B" -- the OO/
   double-town/landmark-DoubleCity passes already implement this via
   their own `.split(" & ")`, unchanged by this pass), with ONE named
   exception, "Maritime Provinces" (too long for its single hex on one
   line despite naming only one place). REVERSES #79's "any multi-word
   single-node name wraps at its first space" and #47's "any multi-word
   off-board zone name wraps" defaults -- `drawSingleNodeNameplate` no
   longer wraps at all (no single-node name has an ampersand or is the
   Maritime Provinces exception), and `drawOffboardNameplate` now wraps
   via the new `offboardNameplateLines` helper, which special-cases only
   "Maritime Provinces" -- "Canadian West" and "Deep South" render as a
   single line now. The #79/#78 width-widening fix (`hexFlatWidth *
   0.92`, so long single-line names don't need to shrink) is UNCHANGED.

84. **Unified Two-Line Nameplate Shield (removes overlap-darkening
   seam).** Reported: on a two-line nameplate, the shared band where
   line 1's own background box and line 2's own background box
   overlapped read as a visibly darker patch -- #82's 0.55-alpha white
   boxes, drawn independently per line, compositely stacked their alpha
   wherever they overlapped. New `drawStackedNameLabel` (paired with an
   extracted `fillRoundedRect` primitive, shared with
   `drawLabelWithBackground`'s own box) measures BOTH lines, unions
   their two padded boxes into ONE rect, and fills it ONCE -- no
   overlap, no seam, regardless of the two lines' relative widths. Also
   picks one SHARED font size for the pair (the smaller of each line's
   own independent `fitFontSize` result) so a length mismatch between
   the two words can't produce a visible size mismatch either. Wired
   into every #83 two-line case: OO double-city, double-town, landmark
   DoubleCity (New York & Newark), and off-board Maritime Provinces.

85. **Off-Board Block Order Flipped: Badge on Top.** Per direct request,
   `drawOffboardNameplate`'s combined block (design note #78c) now
   stacks the revenue badge ABOVE the name text (was name above, badge
   below) -- the block's own total height, dead-center anchoring on the
   hex, and the gap between the two pieces are all otherwise unchanged.

86. **Water Terrain Icon Redesign: Thin Double Strand.** `drawRiverIcon`
   now strokes its gentle S-curve TWICE, as two thin, tightly-stacked
   parallel strands (`iconSize * 0.09` apart), rather than once at the
   old thicker width -- reads more clearly as a cartographic "water"
   symbol. Stroke width dropped 75% (`Math.max(3, iconSize * 0.14)` ->
   `* 0.25`). `drawMountainIcon` unchanged visually, but both icon
   functions gained an optional `colorOverride` param for design note #87
   below.

87. **Compound [Icon + Cost] Badges on Complex Hexes, One Slot Claim.**
   Per explicit request: a "complex" hex -- one with a city/town
   archetype OR real live track (`isComplexHex`, replacing the old
   DoubleCity-only `isDoubleCityHex` check, which MISSED the SingleCity
   `cityDesignation` River hexes -- Toledo/F4, Providence/F22,
   Washington D.C./J14 -- those rendered a full-size, dead-CENTERED icon
   directly under their own revenue badge/nameplate) -- no longer draws
   a standalone Layer-1 terrain icon at all. Instead, the Layer-4
   terrain-cost pass draws ONE compound pill (new
   `drawTerrainCompoundBadge`) containing the icon (shrunk to the cost
   text's own cap-height, in WHITE via the icon functions' new
   `colorOverride`, via the new `drawTerrainIcon` dispatcher) immediately
   adjoined to the cost figure, both on one shared solid-red
   (`fillRoundedRect`) plate. This whole badge claims exactly ONE slot
   from `claimedHexSlots` (`COMPLEX_HEX_TERRAIN_SLOT_PREFERENCE`, the
   renamed-unchanged `DOUBLE_CITY_TERRAIN_SLOT_PREFERENCE`) -- REPLACING
   the old two-claim split (one for the icon in the Layer-1 pass, a
   second for the cost box here). A simple hex (no city/town/track) is
   completely unaffected: standalone icon at center, standalone cost box
   at its own claimed slot, exactly as before.

88. **Water Wave Follow-Up + Icon Moved Above (Not Inside) the Compound
   Badge.** Two direct-feedback fixes on #86/#87:
   (a) `drawRiverIcon` reshaped again -- from one gentle two-arc S-curve
   (still read as "a river," not "waves") to a proper tilde-style wave,
   THREE alternating crests/troughs via new `drawWaveStrand`, the
   standard nautical-chart water glyph. Stroke width bumped +25% off
   #86's own thinned value (net `* 0.3125` off the original pre-#86
   formula, not #86's `* 0.25`), and the two strands pulled further
   apart (`iconSize * 0.09` -> `* 0.16`).
   (b) `drawTerrainCompoundBadge` (#87) revised: the icon no longer sits
   INSIDE the red cost box -- it now perches directly ABOVE it instead,
   in its own ordinary terrain color (the white `colorOverride` is no
   longer used here), both pieces laid out as one vertically stacked
   block centered on the badge's single claimed slot. The red box now
   holds ONLY the cost text again, same as a simple hex's plain cost
   box.

89. **Compound Badge Icon Width Now Exactly Matches Cost Box Width.**
   Per direct request, the terrain icon perched above the compound
   badge's red cost box (#88) is now sized so its rendered width
   exactly equals the box's width, rather than being derived from the
   cost text's cap-height. New constant `TERRAIN_ICON_SIZE_RATIO`
   records each icon's own width-per-`size` and height-per-`size`
   ratios, derived directly from `drawRiverIcon`'s/`drawMountainIcon`'s
   internal geometry formulas. `drawTerrainCompoundBadge` now computes
   `iconSize = boxWidth / ratio.width` (guaranteeing the width match)
   and derives `iconRenderedHeight = iconSize * ratio.height` from
   that, using the derived height (not the old text-height guess) for
   the vertical stacked-block layout math.

90. **Water Wave Icon: Third Crest Added.** Per direct request,
   `drawWaveStrand` (#88) now strokes FIVE segments (three crests, two
   troughs) instead of three (two crests, one trough), within the SAME
   overall `[startX, endX]` span and `amplitude` -- so the strand's own
   bounding width/height are unchanged and `TERRAIN_ICON_SIZE_RATIO`
   (#89) needed no update. Since both the standalone terrain-icon pass
   (simple hexes) and `drawTerrainCompoundBadge`'s perched icon (complex
   hexes) call the same shared `drawRiverIcon` -> `drawWaveStrand` path,
   this one change reaches both render sites automatically.

91. **Terrain Cost Red Box Tightened to the Number.** Per direct
   request, both red terrain-cost boxes -- the plain-hex standalone box
   (`drawLabelWithBackground` call, design note #68) and the compound
   badge's box (`drawTerrainCompoundBadge`, #87-89) -- had their padding
   tightened (2/2 -> 1/1, and 3/2 -> 1/1, respectively) so the red fill
   hugs the cost figure more closely. Originally marked as a TRY-FIRST
   fix, with a possible fallback of reverting this padding and instead
   dropping the font 1pt -- superseded by #92 below, which keeps this
   padding AND drops the font, per direct follow-up request.

92. **Terrain Cost Font Also Dropped 1pt, Padding Kept.** Per direct
   follow-up on #91: rather than reverting the tightened padding, the
   cost text's base font size is ALSO dropped 1pt (`9` -> `8`) in both
   call sites -- the plain-hex box and `drawTerrainCompoundBadge` --
   layering on top of, not replacing, #91's tighter padding. Min font
   size (`6`) is unchanged in both.

93. **Compound Badge: Icon/Box Gap Widened.** Per direct request, the
   small fixed gap between the compound badge's perched terrain icon
   and its red cost box below (`drawTerrainCompoundBadge`'s `iconGap`,
   #88) is widened `1.5 -> 3` -- the two pieces were reading as directly
   touching. Still small enough that they read as one combined unit,
   not two separate ones.

94. **Terrain Cost Badge: `$` Dropped.** Per direct request,
   `TERRAIN_BUILD_COST_LABEL`'s two values ("$80"/"$120") drop their `$`
   prefix (now "80"/"120") -- the red box itself already unambiguously
   marks this as a cost, so the bare number reads cleanly alone. Both
   render paths (plain-hex box and the compound badge) pick this up
   automatically since they just render whatever string the constant
   holds.

95. **Water Icon Third Crest Made Legible; Terrain Cost Font Raised
   Back 1pt.** Two follow-up fixes, per direct feedback: (a) #90's third
   wave crest was mathematically correct but too subtle to actually
   read at the icon's small on-screen size -- `drawRiverIcon`'s
   `amplitude` is bumped `iconSize*0.16 -> iconSize*0.24`, and
   `TERRAIN_ICON_SIZE_RATIO.River.height` updated `0.224 -> 0.28` to
   match (the icon's own bounding height grows with it; width is
   unaffected). (b) Now that #94 dropped the `$` prefix, the terrain
   cost font -- dropped a total of 2pt across #68/#92 -- is raised back
   1pt (base `8` -> `9`, min unchanged at `6`) in both the plain-hex box
   and `drawTerrainCompoundBadge`, since the freed-up horizontal room
   from losing the `$` allows it.

96. **Water Icon: Even Segment Count for THREE Full Waves.** Per direct
   follow-up ("only seeing two waves," even on the larger simple-hex
   icon, after #95's amplitude bump): `drawWaveStrand`'s ODD 5-segment
   count (#90 -- three crests, two troughs, 2.5 cycles, starting AND
   ending on an up-crest) still read as "two waves" since the trailing
   half-cycle doesn't register as a distinct third wave to count. Now
   EVEN, 6 segments -- three crests, three troughs, three FULL
   crest+trough cycles -- an unambiguous count of three. Strand now
   starts up/ends down (was up/up); same overall span and `amplitude`,
   so no `TERRAIN_ICON_SIZE_RATIO` change needed on top of #95's.

97. **Terrain Cost Red Box Padding Reverted.** Design note #91's
   tightened padding (2/2 -> 1/1 plain-hex box, 3/2 -> 1/1 compound
   badge box) is reverted back to its original values in both places,
   per direct request -- the terrain-cost font-size drop (#92, raised
   partway back by #95) stays as the fix for this box's sizing instead.

98. **Water Icon: THIRD STRAND Added (Clarifying #90/#96's "Third
   Wave"/"Only Two Waves" Exchange).** Turns out "add a third wave" and
   the later "still only seeing two waves" report meant a third
   PARALLEL LINE in the icon's existing two-strand shape, not a third
   crest crammed into one line -- #90 (5-segment/3-crest single line)
   and #96 (6-segment/3-cycle single line) both approached the wrong
   problem and are reverted; `drawWaveStrand` is back to its original
   #90 5-segment shape. `drawRiverIcon` now strokes THREE stacked
   strands (`-strandOffset`, `0`, `+strandOffset`) instead of two (was
   `-strandOffset/2`, `+strandOffset/2`), each strand the same shape,
   same `strandOffset` gap between every adjacent pair as the old
   layout's one pair had. `TERRAIN_ICON_SIZE_RATIO.River.height`
   updated `0.28 -> 0.392` for the taller three-strand bounding box
   (width ratio unaffected).

99. **Terrain Cost Font Raised Another 1pt.** Per direct request, the
   cost text's base font size -- `9` after #95's partial restore -- is
   raised another 1pt to `10` in both the plain-hex box and
   `drawTerrainCompoundBadge`. Min font size (`6`) unchanged.

100. **Water Icon: Third Strand Removed; Remaining Two Spaced Further
   Apart.** Per direct request, `drawRiverIcon`'s third strand (#98) is
   removed -- back to two stacked strands, the original #86 layout.
   `strandOffset` (the gap between the two strands) is also widened
   `iconSize*0.16 -> iconSize*0.20` for slightly more separation.
   `TERRAIN_ICON_SIZE_RATIO.River.height` updated `0.392 -> 0.308` to
   match the new (shorter than three-strand, slightly taller than the
   original two-strand) bounding height; width ratio unaffected.

101. **Mountain Icon Enlarged 25%.** Per direct request,
   `drawMountainIcon`'s `iconSize` is bumped `size*0.7 -> size*0.875` --
   every other dimension in that function (`w`, `h`, `cx`/`cy` offsets)
   derives from `iconSize`, so this one change uniformly scales the
   whole icon up 25%, both peaks included. `TERRAIN_ICON_SIZE_RATIO.
   Mountain` updated to match: `width 0.4865 -> 0.608125`, `height
   0.294 -> 0.3675` (both simply the old values times 1.25), so the
   compound badge (#89) keeps sizing this icon to an exact target width.

102. **Mountain Icon Enlarged Another 30%.** Per direct follow-up
   request, `drawMountainIcon`'s `iconSize` is bumped another 30%,
   `size*0.875 -> size*1.1375` (net `1.625x` the original `size*0.7`).
   `TERRAIN_ICON_SIZE_RATIO.Mountain` updated to match: `width
   0.608125 -> 0.7905625`, `height 0.3675 -> 0.47775` (both simply
   #101's values times 1.3), keeping the compound badge's exact-width
   sizing (#89) accurate.

103. **Tooltip: Suppress "$0" Value; Add Terrain Cost.** Two follow-up
   fixes to `describeHexWithValue`, per direct request. (a) The
   "(Value: $X)" suffix is now suppressed for `X === 0` -- reversing
   design note #35/#37's deliberate choice to keep a literal
   "(Value: $0)" in the tooltip for hexes whose on-canvas badge is
   itself hidden at $0; only an actual nonzero value gets the suffix
   now, on both the flat `hexRouteValue` path and the off-board
   `offboardValueForEra` path. `hexRouteValue`'s own return value is
   unchanged (still literally `0` for those hexes) -- only this
   tooltip-text formatting layer changed. (b) A new "(Terrain Cost: $Y)"
   suffix is appended for any Mountain/River hex, reusing
   `TERRAIN_BUILD_COST_LABEL` (same source as the on-canvas red cost
   badge, #68/#87) -- its values are bare digits since #94 dropped their
   `$` prefix for that badge, so a `$` is re-added here for this
   text-sentence context.

104. **13-Slot Engine: Minimum 120-Degree Angular Separation Between
   Claimed Slots.** Explicit task, scope EXPANDS the standing "do not
   refactor the 13-slot placement algorithm" constraint every prior
   typography-only pass (starting #78) had deliberately honored --
   this pass is specifically ABOUT that algorithm, per direct request.
   Requirement 1 (run `pickHexSlot`/mark live track+stations BLOCKED for
   nameplates, off-board blocks, compound terrain badges) needed no new
   code: nameplates and compound terrain badges already route through
   `claimHexSlot` (#72/#74/#87), and `hexBlockedSlots` already marks a
   slot BLOCKED from live track/station occupancy (#70); off-board
   blocks (`drawOffboardNameplate`) remain their own single
   self-contained centered unit (#78c) that never competes for a slot
   with anything else on its hex, so they were never a collision risk
   to begin with and needed no change either.

   Requirement 2 is the real change: every perimeter slot (1-12) sits at
   a fixed 30-degree increment (`SLOT_ANGLE_DEG`, hand-derived from
   `hexSlotDirection`'s own edge/corner angle math and verified against
   all twelve). New `angularConflictSlots(claimedSlots)` flags any slot
   within `MIN_SLOT_ANGULAR_SEPARATION_DEG` (120) of an already-claimed
   slot on the SAME hex -- e.g. claiming Slot 10 (Bottom Point, 90 deg)
   flags Slot 9 (Lower-Right corner, 30 deg, only 60 deg away) and Slot
   11 (Lower-Left, 150 deg, 60 deg away) but leaves Slot 7 (Top Point,
   270 deg, exactly opposite), Slot 1 (edge, 300 deg, 150 deg away), and
   Slot 0 (center, no angle, always compatible) clear -- the task's own
   worked example, reproduced exactly. `pickHexSlot` takes this as a new
   optional `angularConflict` parameter, folded into its existing 3-tier
   open/dead-edge search as an EXTRA soft-avoid layer tried first; if no
   candidate can satisfy both real-collision-avoidance AND angular
   separation at once, it degrades to the original (pre-#104) 4-tier
   search, ignoring angular spacing -- a genuinely packed hex (New York/
   G19, already at its structural limit with only two open corners and
   four open edges before this pass) still gets a real, collision-
   avoiding slot rather than none. `claimHexSlot` computes
   `angularConflictSlots` from its own `alreadyClaimed` set and threads
   it through automatically -- every existing call site (nameplates,
   restriction badges, terrain-cost/compound badges, revenue badges)
   picked this up with NO call-site changes.

   VERIFICATION (Requirement 3), hand-traced against this system's own
   documented facts rather than assumed: G19's layout (two live stub
   edges leaving corners 9/12 and edges 2/3/5/6 open) is UNCHANGED by
   this pass -- its four claims (icon+cost combined at slot 3, "NY"
   badge at slot 12, revenue badge at slot 9) already consume every
   angularly-compatible option, so the graceful degrade reproduces the
   exact pre-#104 result, matching #71/#72/#76's own documented
   resolution. Atlantic City (I19, real printed edges 2/3, town marker)
   previously had its nameplate (slot 10, Bottom Point) and revenue
   badge landing only 60 degrees apart at slot 9 (traced by hand through
   `BADGE_SLOT_PREFERENCE`'s own tier-3 fallback) -- WITH this pass, the
   badge now lands at slot 8 instead, exactly 120 degrees from the
   nameplate, a genuine visible improvement of the kind this task asked
   for. Off-board destinations (Requirement 3's third example) render
   exactly as before, per this note's own Requirement 1 paragraph above.

105. **Per-Feature Slot Preferences Tuned; Claim Order Reordered to
   Nameplate > Terrain Badge > Revenue Badge > Restriction Badge.** Four
   related changes, per direct request, all still within #104's newly
   opened-up scope (this pass is explicitly ABOUT the 13-slot placement
   algorithm, not just its typography).

   (a) `NAMEPLATE_SLOT_PREFERENCE`: now leads with center (slot 0), then
   the top vertex (slot 7), then the bottom vertex (slot 10) -- was
   Upper-Left (12) first, Bottom (10) second. Center is blocked on
   nearly every real hex (see `hexBlockedSlots`), so this is a practical
   no-op fallthrough to the top vertex except on a genuinely blank,
   trackless named hex, where it now correctly centers the nameplate.

   (b) `COMPLEX_HEX_TERRAIN_SLOT_PREFERENCE` (the compound terrain
   icon/cost badge): now leads with (the request's own naming) "Vertex
   2"/"Vertex 4" -- this system's slot 9 (Lower-Right) and slot 11
   (Lower-Left) -- before falling through to the original SE-edge/
   Bottom-Point pair (slots 3/10).

   (c) `RESTRICTION_SLOT_PREFERENCE_DOUBLE_CITY`/`_OTHER` (the "B"/"NY"/
   "OO" badges): UNIFIED to the same list, leading with "Vertex 5"/
   "Vertex 1" (slots 12/8, matching what DoubleCity already preferred),
   THEN every edge midpoint ("then check edges") -- reachable for the
   first time because `drawRestrictionBadge` no longer restricts
   `claimHexSlot`'s fallback pool to `CORNER_SLOTS` (that pool is now
   unused, left defined per this file's own "don't delete superseded
   constants" convention) and its own `badgeCenter` math is generalized
   from the old corner-only `cornerAngleRad` formula to
   `hexSlotDirection(slot)`, which already resolves the correct angle
   for either a corner or an edge slot. The old archetype-driven split
   (SingleCity/DoubleCity preferring opposite corners, to dodge each
   other's DIFFERENT old nameplate position) is retired along with it --
   now that nameplates lead with center/top/bottom instead of
   Upper-Left (item a), that split no longer serves the collision it was
   built to avoid.

   (d) CLAIM/DRAW ORDER: the file's four Layer-4 slot-claiming passes
   were physically reordered (nameplates -- both the landmark loop and
   the gray/named-hex loop, plus the never-competing off-board nameplate
   pass grouped alongside them -- now run FIRST, then the terrain-cost/
   compound-badge pass, then the three revenue-badge loops, then the
   restriction-badge loops LAST) to match the request's own explicit
   "the order they should be claimed in is: nameplate > conjunct terrain
   icon/cost > revenue badge > tile restriction marker" -- was nameplate
   > restriction badge > terrain cost > revenue badge. Verified via a
   line-count-preserving block move (extracted each pass's exact text by
   line range, reassembled in the new order, spliced back in) rather
   than freehand retyping, specifically to rule out any accidental
   content loss or duplication across a ~670-line reorder. Since these
   are also the file's real Layer-4 DRAW calls (`claimHexSlot`'s own
   claim happens inline as each element renders), this changes their
   on-canvas stacking order too, not just claim priority -- restriction
   badges now paint on top in the rare case two Layer-4 elements
   visually overlap, an accepted side effect of honoring the requested
   claim order through the same code path that draws.

106. **Nine-Hex Placement Diagnostic (D6/F6/E11/H12/J14/A19/G19/F22/E23).**
   Reported, hex by hex, against specific requested vertices/edges in the
   user's own established numbering (Vertex N = slot N+7; Edge N = slot
   N+1, both 0-indexed clockwise from the true top -- derived this pass
   by walking `SLOT_ANGLE_DEG` and cross-checked against D6's own
   pre-existing bug, see below). Two distinct root causes, both fixed:

   (a) GENERIC BUG (`pickHexSlot`/`claimHexSlot`/`extendSlotPreference`,
   fixes D6 and contributes to several others): `claimHexSlot` used to
   pre-merge a caller's real, curated preference list with
   `extendSlotPreference`'s "no real preference, last resort" fallback
   tail into ONE combined list before calling `pickHexSlot`, whose
   dead-edge tiers then scanned that WHOLE combined list -- so a
   low-priority fallback-tail slot that merely happened to sit next to a
   permanently dead edge could leapfrog a genuinely open, actually-
   preferred PRIMARY-list slot with no dead-edge adjacency of its own.
   Concretely: D6 (blank, unlaid, nothing blocking its real preference)
   still rendered its terrain-cost badge at Edge 5/slot6 instead of the
   fully-open Vertex 3/slot10, because slot6 happened to sit next to D6's
   one dead edge while slot10 didn't. Fixed by splitting the tiered
   search into a new `pickFromCandidates` helper, run once against the
   caller's real preference list to exhaustion, and only THEN against the
   fallback tail as a separate, later attempt -- the fallback tail can no
   longer outrank an available primary-preference slot, dead-edge-
   adjacent or not. Hand-traced against D6 (now correctly resolves to
   slot10) and re-verified this doesn't change any already-documented
   #104 result (G19/Atlantic City) where the caller's own primary list
   already contained the winning slot.

   (b) PER-HEX EXPLICIT OVERRIDES (`HEX_SLOT_OVERRIDE`, new -- F6, A19,
   H12, G19, F22, E23): several requests asked for one specific claim
   pass on one specific hex to land on a canonical 18xx.games vertex/edge
   that this system's board-wide generic preference lists don't (and
   shouldn't, since changing them would ripple into every OTHER hex
   sharing that pass) produce on their own. `HEX_SLOT_OVERRIDE` is a new
   `"q,r"`-keyed table consulted via `withSlotOverride`, which PREPENDS
   the requested slot onto that one pass's own normal preference list for
   that one hex, rather than replacing it -- so an override still runs
   through every one of `claimHexSlot`'s real safety checks (blocked/
   dead-edge/angular-conflict/already-claimed) and gracefully falls back
   to the pass's own real order if the requested slot turns out to be
   genuinely occupied by real printed track. Every override in the table
   was HAND-VERIFIED against the hex's actual real live edges before being
   added (see the table's own doc comment for the full per-hex trace);
   two requests (G19's revenue badge at Vertex 1, Boston/E23's at Vertex
   0 and its nameplate at Vertex 3) turned out to be genuinely blocked by
   real printed track and degrade to the nearest open alternative instead
   -- the override is kept anyway as accurate documentation and because
   the degrade is a harmless no-op, not a wrong claim. A companion table,
   `HEX_SLOT_RESERVE`, handles the one case (Boston/E23) where an EARLIER
   pass's own graceful fallback would otherwise claim the one slot a
   LATER pass has an explicit, achievable override on (its restriction
   badge's Vertex 5) -- it filters that one reserved slot out of every
   other pass's candidate list on that hex, so the later pass's request
   isn't accidentally starved by going second.

   (c) TWO NON-SLOT FIXES, requested directly rather than via placement:
   the Erie/E11 reserved station marker's fixed neutral-margin point
   (previously straight down from center, shared by all four
   `YELLOW_OO_HEXES`) is redirected to Vertex 2/slot9 for E11 SPECIFICALLY
   (same `0.46 * hexSize` magnitude, new direction via `hexSlotDirection`
   -- the other three OO hexes were never reported and are unchanged);
   and Washington/J14's `NAMED_HEX_LABELS` entry is reverted from
   "Washington, D.C." (#47's own explicit request) back to the bare
   "Washington", per this pass's own explicit instruction to drop "D.C."
   outright rather than relocate the nameplate.

   NOT changed: the closing observation that non-nameplate offset
   magnitudes (`size * 0.44` for revenue badges, `apothem * 0.7` for
   restriction badges, `hexSize * 0.58` for terrain-cost points) might be
   "simply too large" was evaluated but not acted on here -- every
   collision this pass traced back to a SLOT choice (wrong corner/edge),
   not a magnitude bleeding into a neighboring hex or this hex's own
   track at the correct slot; shrinking these board-wide would touch
   every hex on the map for a problem that, on inspection, wasn't a
   magnitude problem. Left as an open question if collisions persist
   after this pass's slot-level fixes.

107. **Revenue Badge Offset Reduced.** Reported directly, board-wide (not
   tied to any one hex): revenue badges sit far enough out toward the hex
   boundary to interfere with other elements. `drawValueBadge`'s
   `badgeCenter` magnitude -- `size * 0.44` along whichever slot
   `hexSlotDirection` resolved, applied uniformly to corner AND edge
   slots alike -- reduced to `size * 0.38`, a real, board-wide pullback
   toward hex center for every revenue badge on the map, not a per-hex
   override. Chosen to stay a comfortable margin clear of the
   `size * 0.22`-radius station circle at hex center for any realistic
   badge size (this file's own text-driven `badgeRadiusForLabel` keeps
   even a 3-digit value well under `size * 0.16`) while still pulling the
   badge meaningfully closer to center than before. This is the
   magnitude question #106's own closing note left open, now acted on
   directly per this request rather than left as a maybe.

108. **Revenue Badge Offset Increased Past The Original Value.** Direct
   follow-up: #107's `0.38` (already a real, verified board-wide change)
   was reported as no perceptible difference, and the request was to
   push the badge FURTHER from center than it originally was -- not
   merely undo #107 back to the pre-#107 `0.44`. Raised to `size * 0.55`,
   re-checked against both boundary shapes a badge can sit at (an EDGE
   slot's boundary is the `apothem`, `size * 0.866`; a CORNER slot's is
   the full `size`): `0.55` plus this file's own documented worst-case
   badge radius (`size * 0.16`) reaches `size * 0.71` at most, clearing
   even the tighter edge-slot boundary by `size * 0.156`, so the badge
   stays fully on-hex at this larger magnitude at every one of the eight
   slots `BADGE_SLOT_PREFERENCE` can resolve to.

109. **Revenue Badge Offset Increased Again, To `0.65`.** Direct
   follow-up to #108. Same two-boundary check, numbers updated: at a
   CORNER slot (boundary = full `size`), `0.65` plus the documented
   worst-case badge radius (`size * 0.16`) reaches `size * 0.81`, still
   `size * 0.19` clear. At an EDGE slot (boundary = `apothem`, `size *
   0.866`), that same worst-case reach leaves only `size * 0.056` of
   clearance -- a real narrowing from #108's `0.156`, flagged here rather
   than silently accepted: a wide printed value landing at an edge slot
   is now close enough to the boundary that it could start to look
   visually crowded there, though it does not mathematically cross it at
   today's badge sizing. Implemented as requested.

110. **Vertex/Edge Convention Confirmed; Six More Hexes Placed; G19
   Terrain Badge Bug Found And Fixed.** The user supplied their own
   explicit numbering this pass ("Vertex 0 is the top point... Edge 0 is
   the edge immediately to the right of Vertex 0... clockwise... Edge 5
   looping back to Edge 0") -- cross-checked against this system's own
   `SLOT_ANGLE_DEG`-derived convention (Vertex N = slot N+7, Edge N =
   slot N+1, both already in use since design note #106's own D6
   diagnosis) and it matches exactly, confirming every prior pass's
   translation was correct.

   CORRECTION (found while placing G19's terrain badge): a prior pass
   concluded New York has no terrain badge at all, checking only
   `LANDMARK_HEXES` (which indeed carries no `type` field). Missed that
   `STATIC_BOARD_HEXES` ALSO carries its own separate `q:6,r:6` entry --
   `{ type: "River", printedColor: "Yellow" }`, added by design note #71
   specifically to give New York its real $80 water terrain cost -- so
   the terrain-cost pass DOES process G19. Added the missing `terrain: 9`
   override and a matching `HEX_SLOT_RESERVE` entry (terrain's claim at
   Vertex 2 would otherwise leave the revenue badge's own fallback search
   free to land on Vertex 5, stealing the restriction badge's slot).

   NEW HEXES: J14/Washington (nameplate -> Vertex 0, terrain -> Vertex 2,
   both fully open on this blank hex) and I15/Baltimore (nameplate ->
   Vertex 0, open; revenue badge's requested Vertex 2 HAND-VERIFIED
   blocked by Baltimore's own real edge-0 track, degrades to Edge 2;
   restriction badge's requested Edge 4 HAND-VERIFIED open, achieved).

   E23/Boston's revenue badge REQUEST CHANGED from Vertex 0 (already
   known blocked, per #106) to Vertex 5 (open) -- `HEX_SLOT_OVERRIDE`
   updated, and `HEX_SLOT_RESERVE`'s Boston entry REPOINTED from
   `restriction` to `revenue` accordingly, since revenue is now the pass
   with the achievable claim on that slot and the nameplate (running
   earlier) is the one that needs to be steered around it. The "B"
   restriction badge has no explicit request this round and simply takes
   its own next-best open slot.

   A19's revenue badge request (Edge 1) matches #106's own
   already-corrected placement there exactly -- independent confirmation
   that fix was right; no change needed. F22's nameplate request (Vertex
   0) likewise already matches its existing override -- no change.

111. **Explicit Override System Fixed -- Real Bug, Not A Sync Issue.**
   Reported with a screenshot (J14/Washington): the nameplate rendered at
   Vertex 1, not the override's Vertex 0; the terrain badge rendered at
   Vertex 4, not Vertex 2. HAND-VERIFIED by computing Washington's real
   dead edges (the same coordinate-extraction method design note #106
   used for D6): J14 has exactly ONE dead edge, its own east
   board-boundary edge, whose two guard corners are Vertex 1/slot8 AND
   Vertex 2/slot9 -- BOTH of the two corners this hex's reports actually
   landed on or got displaced from. Root cause: `withSlotOverride`
   (#106) prepended the override slot onto the pass's full preference
   list and ran the COMBINED list through the normal tiered search --
   whose tier 1/2 favor ANY dead-edge-adjacent, open slot over a merely-
   open one, REGARDLESS of list position. Vertex 0/slot7 (the override,
   genuinely open, first in the list) isn't dead-edge-adjacent here, so
   tier 1 skipped past it and matched Vertex 1/slot8 instead, purely
   because slot8 happens to sit next to that one dead edge -- the exact
   D6 bug from #106, reproduced one level up (inside a single already-
   combined list, not the primary-list/fallback-tail split #106 fixed).
   Once the nameplate wrongly landed on slot8, its own angular-conflict
   avoidance then pushed the terrain badge off Vertex 2/slot9 (also
   dead-edge-adjacent, and only 60 degrees from slot8) onto Vertex
   4/slot11 instead -- a real, mechanically-explained cascade, not
   randomness.

   FIXED by giving an explicit override its own resolution path, entirely
   separate from the tiered preference search: new `resolveSlotOverride`
   (looks up `HEX_SLOT_OVERRIDE`, returns `undefined` if the slot is
   `HEX_SLOT_RESERVE`d for a different pass) and `claimHexSlotPreferring`
   (tries that slot directly -- blocked/already-claimed check ONLY, no
   dead-edge tiering, no angular-conflict soft-avoidance either, since an
   explicit request should win a mere tiebreak heuristic -- and falls
   through to the ordinary `claimHexSlot` tiered search over the pass's
   UNMODIFIED preference list only if the override is missing or
   genuinely unusable). `withSlotOverride` itself is superseded and no
   longer called anywhere (kept defined, unused, per this file's own
   convention). Every hex/pass in `HEX_SLOT_OVERRIDE` re-verified by hand
   against this new resolution path -- every previously-documented
   "gracefully degrades due to real track" case (G19/Vertex 1, I15's
   revenue badge, E23's nameplate) still degrades the same way, since
   only the OVERRIDE side changed; the ordinary tiered fallback search
   itself is untouched.

112. **H18's Restriction Badge -- Same Dead-Edge Bug, No Override
   Involved.** Reported directly, with the correct root-cause guess
   attached: H18's "OO" restriction badge wasn't at Vertex 5 like the
   other three `YELLOW_OO_HEXES`. HAND-VERIFIED (same coordinate-
   extraction method as #106/#111): H18 has exactly one dead edge (its
   own east board-boundary edge), and that edge's two guard corners are
   Vertex 1/slot8 and Vertex 2/slot9. `RESTRICTION_SLOT_PREFERENCE_
   DOUBLE_CITY` leads with Vertex 5/slot12, genuinely open here (H18 has
   no real printed track at all) -- but #111's diagnosis applies
   unmodified: tier 1's "prefer a dead-edge-adjacent open slot" scan
   matched Vertex 1 (later in the list, but dead-edge-adjacent) before
   ever confirming Vertex 5 was already a perfectly good, if merely
   "just open," answer. This is NOT the override system #111 fixed --
   H18 had no `HEX_SLOT_OVERRIDE` entry at all, so this is the same
   root-cause tier behavior surfacing in the PLAIN, non-override
   preference-list path instead. Fixed the same way #111 fixes an
   override: added `"5,7": { restriction: 12 }` to `HEX_SLOT_OVERRIDE`,
   which now resolves through `claimHexSlotPreferring`'s direct
   blocked/claimed check, bypassing the dead-edge tier entirely.
   CONFIRMED the other three OO hexes (E5, D10, E11) are unaffected --
   all three are fully interior with zero dead edges, so their own tier
   1 never matches anything and they already fall straight to Vertex 5
   via tier 3, exactly as expected, no override needed for them.

113. **G19 Revenue Badge Force-Placed At Vertex 1, Collisions And All.**
   Direct request: "I want to see how it looks there, I don't care what
   it overlaps" -- a genuinely different ask from every prior placement
   request, which all wanted the SAFEST achievable slot. New
   `HEX_SLOT_FORCE` table + `claimHexSlotForced`, kept deliberately
   separate from `HEX_SLOT_OVERRIDE`/`resolveSlotOverride`: a force skips
   every collision check this file has (real printed track, already-
   claimed-on-this-hex, angular crowding) entirely -- it always wins. New
   York's revenue badge now sits at Vertex 1/slot8, directly on top of
   its own real NE track stub, exactly as asked. The claim is still
   RECORDED in `claimedHexSlots`, so the terrain/restriction passes on
   the same hex still steer clear of slot8 themselves (their own
   collision-avoidance isn't what's being disabled here) -- only the
   revenue badge's own check is skipped. `HEX_SLOT_OVERRIDE`'s existing
   `"6,6": { revenue: 8, ... }` entry is now moot for revenue specifically
   (the force checked first) but left in place, both as an accurate
   record of the original request and because it's a harmless no-op.

114. **G19: Vertex 1 Confirmed Bad, Moved To Edge 4/Edge 5 Instead.**
   Direct follow-up after seeing #113's forced result ("I see it is a
   problem there"): revenue badge -> Edge 4/slot5, restriction badge
   ("NY") -> Edge 5/slot6. HAND-VERIFIED against New York's real
   `{ edges: [1, 4] }`: neither Edge 4's guard edge (internal edge 3) nor
   Edge 5's (internal edge 2) is one of those two live edges, so both
   resolve directly through the ordinary `HEX_SLOT_OVERRIDE` path with no
   degrade needed -- unlike Vertex 1 (blocked) and Vertex 5 (open, but
   needed protecting from an earlier pass's fallback via
   `HEX_SLOT_RESERVE`) before them. `HEX_SLOT_FORCE`'s G19 entry removed
   (no longer forcing anything -- the new slots are genuinely
   collision-free) and `HEX_SLOT_RESERVE`'s G19 entry removed too
   (nothing competes for Edge 4/Edge 5 the way things once competed for
   Vertex 5) -- both tables' machinery stays in place for future use, just
   with G19 no longer needing either.

115. **E23/Boston's Nameplate Force-Placed At Vertex 3.** Reported with a
   suspicion attached: that the nameplate's inability to reach Vertex 3
   (degrading to Vertex 4 since design note #106) was the same dead-edge
   tier leapfrog bug #111/#112 fixed elsewhere. CHECKED, not assumed: it
   is not -- Vertex 3/slot10's two guard edges are internal edges 4 and
   5, and edge 5 IS one of Boston's own two real live edges
   (`LANDMARK_TRACKS["Boston"]`'s `{ edges: [1, 5] }`), so this was
   always a genuine track collision, correctly identified as such by
   `HEX_SLOT_OVERRIDE`'s own graceful degrade the whole time -- not a
   bug to fix. Direct follow-up request accepted the collision anyway
   ("move it to Vertex 3 even if it collides with the track"), so
   `HEX_SLOT_FORCE` (design note #113's mechanism, built for exactly
   this) gained an E23 entry: `{ nameplate: 10 }`. Boston's nameplate now
   renders at Vertex 3 unconditionally, overlapping its own SE track
   stub as requested.

116. **Reserved Station Markers Heavily Grayed/Transparent.** Direct
   request: "make sure that the station reservation markers are heavily
   grayed out, or transparent, or something similar, to show players
   that the station is reserved but not currently blocking routes."
   `drawStationTokenMarker`'s `muted` (reserved/unfloated) path is
   REVERSED from #46/#48's original solid-opaque-navy-plus-full-brand-ring
   treatment: the fill is now a neutral mid-gray (`#9CA3AF`, not the
   company's own color) AND the whole badge (fill, ring stroke, ticker
   text, halo) is drawn at reduced `globalAlpha` (0.45) via a `ctx.save()`
   / conditional-alpha / `ctx.restore()` wrap -- combining "grayed out"
   and "transparent" per the request's own "or something similar."
   Floated (real, non-muted) badges are completely unchanged: full
   opacity, full company color, unmuted brand-color ring.

117. **Tooltip `(Stations: N)` Suffix.** Direct request: "let's add to
   the tooltip display a (Stations: ) when a tile has stations on it."
   `N` comes from `archetypeForHex`, cross-referenced against
   `hexmap.rs`'s real `execute_place_station_token` "tokenable city" rule
   (module doc comment #27: only `MajorCityHub`/`DoubleCityHub`/
   `BostonHub`/`NewYorkHub` terrains can ever hold a station token,
   `SmallTown`/`DoubleTown` explicitly excluded) so this is the actual
   real station capacity, not a guess from icon shape:
   `"SingleCity"` -> 1, `"DoubleCity"` -> 2, `"SingleTown"`/`"DoubleTown"`/
   `"Plain"` -> 0 (no suffix printed at all). Appended in
   `describeHexWithValue` last, after the existing `(Value: $X)` and
   `(Terrain Cost: $Y)` suffixes, matching that function's established
   left-to-right ordering (name, value, cost, capacity).
118. **46-Tile Tray Catalog Sync (backend Audit G-5).** The backend
   catalog stopped using this engine's synthetic sequential `tile_id`s
   and now keys every entry on the tile's REAL physical 1830 tray number,
   across the complete 46-tile roster. `GetLegalTilePlacements` and
   `GetMapGrid` both return those tray numbers now. Four parts:

   (a) `TILE_CATALOG` rewritten wholesale -- 20 old entries out, 46 real
   ones in. See that constant's own doc comment for the full old-id ->
   tray-number table and, more importantly, for why this could not be a
   partial patch: the two id spaces OVERLAP with different meanings (old
   internal 16/18/19/20/23/24 were "B"/"NY"/"OO" hub artwork; real tray
   #16/#18/#19/#20/#23/#24 are ordinary green plain track), so a stale
   entry would resolve to confidently WRONG artwork rather than to the
   honest unknown-tile placeholder. The invented terrain tiles (old ids
   4, 5, 12) and invented green filler (old 11, 13) are gone -- terrain
   is now charged per HEX, see `TERRAIN_BUILD_COST_LABEL`. Note real tray
   #4 exists and is a single-town straight; it is NOT the deleted river
   tile that used to occupy id 4.

   (b) Three real rendering bugs the new geometry exposed, all fixed in
   `drawTrackPath` (each has its own inline note): `cityGroups` is now
   tested BEFORE the 2-live-edge shortcut, because #59 ("OO" Green) is a
   two-city tile with exactly two live edges and was being drawn as a
   single through-route joining them; `cityGroups` edges are now rotated
   into post-rotation edge space before being intersected with the live
   set, which they never were, so rotated NY/OO tiles were dropping most
   of their own track; and the station/dit marker block is hoisted out of
   the 3+-edge branch and keyed purely on TERRAIN, because #57 (the
   yellow city tile every plain-city hex starts from) has two live edges
   and was drawing no station at all, while the five double-town tiles
   have four live edges each and were drawing no dits.

   (c) Unknown-`tile_id` fallback upgraded from a bare red "#N?" to
   `drawUnknownTilePlaceholder`'s neutral dashed provisional artwork, in
   both render paths. All 46 real tiles are mapped, so this is now purely
   a future-drift safety net -- but it is one the player can still read
   and act on, which matters because `TileSelectionPopup` offers whatever
   the contract returns, unfiltered.

   (d) A dev-only drift tripwire next to `TILE_CATALOG_BY_ID` warns if
   the mirror's length or unique-id count ever stops matching
   `TILE_CATALOG_SIZE`, since a duplicated id silently collapses inside
   the `Map` and shadows an entry.
119. **Discrete Double-Town Paths.** The five DoubleTown tiles (#1, #2,
   #55, #56, #69) now render their two real, separate town routes instead
   of one generic fan-to-centre, and place each dit ON its own route.

   The problem was informational, not cosmetic. Each of these tiles has
   four live edges paired into two independent two-edge routes, and
   `connections` is a flat union that cannot say which edge pairs with
   which. It is not merely lossy in principle: #1 and #55 share the
   identical mask `0b01_1011` while pairing {0,4}+{1,3} versus {0,3}+{1,4},
   and #2 and #56 share `0b00_1111` while pairing {0,3}+{1,2} versus
   {0,2}+{1,3}. No function of the mask can distinguish those, so all four
   drew as the same four-way junction with two dits floated at fixed
   offsets -- wrong topology and wrong dit placement on all five.

   The data already existed on the backend: `hexmap::TILE_CATALOG` has
   carried a seventh edge-pair field since Audit G-9 and `pathfinding.rs`
   routes on it. What was missing was a way for a client to see it, so
   this pass added `paths` to `msg::MapTileEntry` (resolved contract-side
   through the new `hexmap::effective_base_tile_paths`, which keeps the
   stored-list-then-catalog fallback `effective_tile_paths` already used,
   minus the rotation -- this response states edges pre-rotation and
   reports `orientation` separately, matching `connections`).

   Two sources, deliberately, resolved by `pathsForTile`: the query row
   wins for a laid tile, and this file's `TILE_CATALOG` mirror is the
   fallback. The mirror is not redundancy for its own sake --
   `TilePreviewThumbnail` renders tiles that are not on the board yet and
   has no query row by construction, so without a mirror copy a previewed
   double-town would draw differently from the same tile once laid. The
   same fallback covers a contract deployed before `MapTileEntry.paths`
   existed, which simply omits the key.

   Scope is deliberately narrow: the branch is gated on BOTH
   `terrain === "DoubleTown"` and paths actually being present, so only
   those five tiles can reach it. Multi-edge city and plain tiles carry
   path lists in the Rust catalog too, but their existing branches already
   render them correctly, so they are untouched and the mirror does not
   duplicate their paths.

   One honest deviation, noted at the branch: each route is drawn through
   its own `twoNodePositions` node rather than through hex centre, so the
   two dits sit on their own track instead of colliding at the middle.
   Real #55 draws two straights that genuinely cross there. The topology
   -- which edge connects to which -- is exactly what the catalog
   declares; only the curvature is a presentation choice.
   SUPERSEDED by design note #121: that deviation was not as small as
   this note claimed. Bending #55's two straights around offset nodes
   turned its X into a pair of visibly bowed arms, and warped #56 badly
   enough to be hard to read. The generalized offset is gone; see #121.
120. **Tile Picker Opens Without A Chain.** Reported as "the tile picker
   refuses to open at all" when running `npm start` with no backend, no
   exception thrown, and the "[TileSelection] hex clicked" log still
   printing normally.

   NOT caused by design note #119, despite arriving right after it. That
   pass touched the catalog mirror, `rotatePaths`/`pathsForTile`/
   `assignTownNodes` and one `drawTrackPath` branch -- all canvas
   rendering, none of it in the click pipeline, and `pathsForTile`
   returning `undefined` is its designed fallback, not a failure. Nothing
   in the picker flow queries `paths` at all: those ride on `GetMapGrid`
   (board data), while the picker runs `GetLegalTilePlacements`, which
   #119 never touched. No promise was left pending either.

   The real cause was long-standing and structural. The click handler's
   guard tested all four interceptor props at once --
   `if (!queryClient || !contractAddress || gameId === undefined ||
   protocolId === undefined) return;` -- and those props go missing for
   two unrelated reasons. Route-select mode omits them ON PURPOSE, to keep
   a route-point click from also popping the picker (design note #7,
   App.tsx design note #11). Running without a wallet or node leaves ONLY
   `queryClient` undefined, since the other three are constants. Both hit
   the same `return`, so `onHexClickQuery` never fired, App.tsx's
   `hexClickQuery` stayed `null`, and its `status === "success"` gate
   never rendered the popup. The picker had no offline path whatsoever --
   it wasn't hanging or failing, it had decided there was nothing to do.

   Fix: split the guard on that exact distinction. Missing hex identity
   (`contractAddress`/`gameId`/`protocolId`) still returns silently, so
   route-select mode is untouched. Missing `queryClient` alone now falls
   back to `localCatalogPlacements`, and reports `status: "offline"`.

   That fallback filters by ERA AND NOTHING ELSE, and deliberately does
   not reimplement `hexmap::legal_tile_placements` -- no connectivity, no
   reservations, no colour-step, no tray depletion. Hence a distinct
   status rather than a flag on `"success"`: a separate variant makes the
   type checker point at every consumer that must decide what to do with
   unvalidated data, where a flag lets a consumer treat it as
   authoritative just by not knowing to look. `TileSelectionPopup` renders
   it under an explicit banner and refuses to dispatch from it.
121. **Canonical Double-Town Artwork, Drawn Explicitly.** Reported: the
   generalized double-town renderer from design note #119 produced
   non-canonical track. #55 -- which is simply two straights crossing in
   an X -- came out with both arms visibly bowed, and #56's two gentle
   curves were warped enough to be hard to read.

   The cause was a priority inversion in #119. That pass routed each town's
   track through its own offset node so the two dits could not collide at
   hex centre. In other words it moved the TRACK to make room for the
   MARKERS. For the two tiles whose whole character is a straight line,
   that is exactly backwards: a straight that bows is no longer the tile.

   Fixed by abandoning the general algorithm. There are exactly five
   double-town tiles in all of 1830 and there will never be a sixth, so
   `DOUBLE_TOWN_ROUTES` now states each one's artwork explicitly, keyed on
   `tileId`. `drawDoubleTownRoute` draws each declared edge pair in its
   natural shape and reports the point halfway along what it actually
   drew, so the dit follows the track instead of the track following the
   dit:
     - opposite edges take a literal `lineTo`, not a Bezier that happens
       to look straight, so #55's X cannot bow by even a pixel;
     - everything else takes ONE cubic Bezier with control points on each
       endpoint's own inward normal at the file's standard `0.3` reach,
       which yields a tight corner for a 60-degree pair and a shallow bow
       for a 120-degree pair with no per-shape fudging.

   Only #55 needs a marker rule of its own, because it is the only tile
   whose routes are BOTH straights and therefore share a midpoint at dead
   centre. Its two dits slide out along their own arms toward adjacent
   edges -- moving the markers, never the geometry.

   Consequence worth knowing: this renderer no longer reads
   `msg::MapTileEntry::paths` for artwork, and #119's `rotatePaths`/
   `pathsForTile` are deleted as dead. The contract still sends the field
   and `TileCatalogEntry.paths` still mirrors it -- the mirror now feeds a
   dev-mode tripwire that cross-checks `DOUBLE_TOWN_ROUTES` against the
   catalog, so the explicit table cannot silently drift from the data.

---

## Addendum: notes #131 onward

Everything above is the original header block, verbatim. The entries below were
written as inline comments during later passes and referenced by number without
ever gaining a header entry, so `design note #N` pointed at nothing. Recorded
here so every reference in the codebase resolves.

131. **Hardcoded Tile Artwork ("Art, not Math").** `TileGraphics.ts` holds
     literal, hand-authored SVG path strings for every Green/Brown city and
     town tile, replayed on the existing canvas via `Path2D` under a
     `translate → rotate → scale` transform. `drawHardcodedTileArtwork` is the
     first statement in `drawTrackPath`, so a catalogued tile can never reach
     `bezierTrackSegment`, `edgeInwardNormal` or `drawDoubleTownRoute`.
     Orientation is a rigid rotation of the authored art, exactly as cardboard
     is turned on the board.

132. **Revenue comes from the chain.** `MapTileEntry.revenue` is `Uint128`, so
     it arrives as a JSON **string** — `chainTileRevenue` parses it in one
     place. Precedence in `drawTileOverlays` is `revenueOverride ?? entry.revenue
     ?? terrainBaseValue(...)`, using `??` and never `||`, because a revenue of
     `0` is a legitimate answer that must beat the level below it.

133. **Laid tiles win over pre-printed landmark artwork.** The
     `!landmarkAt(...)` guard on the laid-tile pass is gone, and the landmark
     track and badge passes now yield whenever `hexHasLaidTile`. Without this,
     New York, Boston and Baltimore could never display a laid tile's artwork —
     the symptom reported as "#62 draws crossing track with a station on the
     intersection", which was the pre-printed stubs, not the tile.

134. **Per-slot station tokens.** A multi-slot city draws one ring per slot, and
     `tileCitySlotPoints` places tokens on those rings. Slot order is chosen
     client-side by ascending `company_id` — deterministic across clients, but
     not authoritative about which physical slot a company "owns", since the
     chain records capacity as a count.

135. **Catalog revenue mirror.** `TileCatalogEntry.revenue` mirrors the backend
     catalog so the tile picker and offline mode print the figure the contract
     will pay. Twelve tiles deviate from their terrain bucket; all twenty-two
     with a printed value are mirrored anyway, because "agrees with the bucket"
     is a coincidence of today's numbers, not a property.

136. **Terrain fees are per-hex, not per-type.** `terrainBuildFeeAt(q, r)`
     mirrors `hexmap::terrain_build_fee` structurally. $80 river / $120
     mountain — the contract's figures, and the printed board's; the spec
     document's "$20 / $80" is wrong.

137. **Route overlays.** `routeOverlays` draws traced train routes after every
     track pass and before station markers, so a route reads as running *on*
     the rails without burying the markers. Each hop is two
     `bezierTrackSegment` halves through the shared edge midpoint;
     non-adjacent pairs are skipped rather than bridged.

138. **Hook dependency corrections.** The main `draw` callback depends on
     `mapGrid`, not `mapGrid.tiles` — its body reads the whole object.
     `handlePointerMove` gained `mapGrid` and `currentEra`, both of which feed
     the hover tooltip and would otherwise report stale figures indefinitely.

139. **The tile picker's offline guard.** `!contractAddress` moved out of the
     "interceptor deliberately off" test and down beside `!queryClient`. It only
     ever passed because the address used to be a truthy placeholder; once F-4
     made it correctly `undefined`, that guard swallowed every hex click in
     offline sandbox mode.

140. **The current-round panel leads the Rules page.** Nothing had deleted it —
     it had been demoted into a wrapping side column beneath five paragraphs of
     prose, which reads as "vanished" below ~1000px.

141. **Quick Reference restored, and "Place a Station" added.** The compact
     one-line-per-step strip returned alongside the full prose section. The
     Operating Round flow had been missing the station-token step entirely, and
     the Lay Track text actively denied it existed.

142. **`Routes` split out of `Dividends`.** Running trains produces the revenue
     figure; declaring dividends decides what to do with it, and the second
     cannot be answered before the first has happened.

143. **Round accordion.** All three rounds collapse; the active one sorts to the
     top and auto-opens on a genuine round *transition* (tracked against a ref,
     not re-fired by the poll). Manual toggles stick — the auto-open is additive.

144. **Six-phase mirror.** `OperatingSubPhase` mirrors `or_phase::OR_PHASE_ORDER`,
     which the contract now enforces rather than describes. Skips are real
     `AdvanceOperatingSubPhase` dispatches with no optimistic advance.

### Still dangling

`design note #38`, `#39`, `#41` and `#122`–`#130` are referenced from
`HexGridRenderer.tsx` but were never defined in the header block either — the
original numbering jumps straight from #36 to #42. These predate the Phase 0
extraction and are recorded here as a known gap rather than invented.

