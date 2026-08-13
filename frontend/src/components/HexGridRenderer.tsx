// frontend/src/components/HexGridRenderer.tsx
//
// Milestone 3: the 2D Canvas Graphics Engine's hex-map layer -- renders
// `QueryMsg::GetMapGrid`'s response (see `src/msg.rs`'s `MapGridResponse`/
// `MapTileEntry`) as a real hex board: tile fills colored by terrain, rail
// track paths decoded from each tile's connection bitmask and orientation,
// and the three reserved 1830 landmark cities shaded and labeled at their
// fixed coordinates. Sibling to the (not yet built) StockMarketRenderer
// sketched in frontend_blueprint.md Section 3.3 -- see that document for
// how the two compose inside `<GameCanvas>`'s layered `<canvas>` stack.
//
// Design notes:
// 1. **Pointy-top axial hex geometry, verified against `HEX_NEIGHBOR_OFFSETS`.**
//    `hexmap.rs`'s edge indices (0-5) are defined purely by adjacency
//    (`HEX_NEIGHBOR_OFFSETS`), not by any pixel angle -- the backend never
//    says which screen direction edge 0 points in. This file derives that
//    mapping itself: `axialToPixel` is the standard pointy-top axial
//    conversion, and `edgeAngleRad(i) = -60 * i` (in degrees, before the
//    radian conversion) was reverse-engineered by computing each
//    `HEX_NEIGHBOR_OFFSETS[i]` entry's actual pixel delta under that same
//    conversion and reading off its angle (edge 0 -> 0deg, edge 1 -> -60deg,
//    ... edge 5 -> -300deg / equivalently 60deg) -- NOT the naive `+60 * i`
//    a generic hex-corner formula would suggest. Getting this backwards
//    would silently draw every tile's track pointing at the wrong
//    neighbors while still *looking* like a valid hex grid, so this is
//    called out explicitly rather than left as an unexplained sign flip.
// 2. **Client-side catalog mirrors, not queried.** `GetMapGrid` only
//    returns each laid tile's `tile_id` + `orientation` (see
//    `MapTileEntry` in `msg.rs`) -- not its connection bitmask, terrain, or
//    color -- and there's no query exposing `hexmap::TILE_CATALOG` or
//    `hexmap::LANDMARK_HEXES` at all. `TILE_CATALOG`/`LANDMARK_HEXES`
//    below are therefore hand-kept TypeScript mirrors of those Rust
//    constants. DESIGN GAP: these will silently drift out of sync if the
//    backend catalog ever changes without a matching frontend edit; the
//    durable fix is a `QueryMsg::GetTileCatalog`-style query (or a codegen
//    step off the contract's schema) so the frontend derives this data
//    instead of duplicating it by hand. Out of scope for this component;
//    flagged here so it isn't mistaken for an oversight, and an unknown
//    `tile_id` renders a visible red placeholder rather than silently
//    nothing, so a catalog drift is loud instead of invisible.
// 3. **Track rendering is this component's own convention, not the
//    backend's.** `hexmap.rs` itself documents that a tile's connection
//    bitmask "records which of its six edges carry a track stub, not how
//    those edges pair up internally into a routed path through the tile."
//    For a tile with exactly two live edges (the common case), this file
//    draws one path between them -- a straight `lineTo` for a true
//    opposite-edge pair, an `arcTo` curve otherwise. For a tile with more
//    than two live edges (a multi-spur tile like tile 12, or a six-edge
//    city hub), it draws a `lineTo` spoke from each live edge into a
//    shared center node instead, since the bitmask alone doesn't say which
//    pairs are meant to route together. This is a legible, honest
//    simplification, not a claim about real 1830 tile art.
// 3b. **Station Markers & Name Plates.** Every laid tile's terrain now gets
//    an explicit destination marker, not just a bare track path: a
//    `TerrainType.SmallTown` tile (2 live edges) draws a small solid white
//    "dit" circle at its hex center, matching the real 1830 tile-art
//    convention (a small dot/crossbar for a town); a
//    `TerrainType.MajorCityHub` tile (3+ live edges) draws a larger white
//    station circle with a dark outline, instead of the previous plain dark
//    junction dot. An ordinary multi-spur *non-city* tile (e.g. tile 12's
//    3-edge mountain junction) keeps the small neutral dark dot -- it's a
//    track junction, not a passenger destination, so it doesn't get a white
//    marker. Every landmark/off-board/dit/station text label now also runs
//    through `fitFontSize`, which shrinks the font (down to a floor) until
//    `ctx.measureText` confirms it fits within the hex's own flat-to-flat
//    width, so a label can never overflow its hex or run into a drawn track
//    line regardless of `hexSize`.
// 4. **Redraw strategy.** Prop-driven redraws (a new `mapGrid`, a resize,
//    a `hexSize` change) go through a plain `useEffect` -- simplest and
//    cheapest for state that changes only when new chain data arrives.
//    Pointer-driven pan/zoom redraws instead go through a
//    `requestAnimationFrame`-coalesced scheduler (`scheduleDraw`), so a
//    burst of `pointermove`/`wheel` events collapses to at most one canvas
//    repaint per animation frame rather than one per event.
// 5. **One-shot auto-fit, not a permanent camera reset.** On first mount,
//    the view pans/zooms once to fit the entire static board outline (see
//    note #6) plus every landmark and already-laid tile in frame. After
//    that single fit, later `mapGrid` updates redraw in place without
//    touching the user's own pan/zoom -- re-fitting on every poll would
//    otherwise fight anyone who'd manually navigated the board.
// 6. **Static board background -- fixes the "blank map at launch" problem,**
//    **now the AUTHENTIC 1830 board, not an illustrative approximation.**
//    Before this pass, an empty `mapGrid.tiles` (i.e. every game at the
//    moment it's created) rendered as nothing but the bare dark canvas
//    background -- no board was visible until the first tile was laid.
//    `STATIC_BOARD_HEXES` below pre-renders the *entire* real 93-hex 1830
//    play area (terrain-classified: plain, mountain, river/water, and the
//    red off-board revenue zones) the instant the component mounts.
//    SOURCES (cross-verified, not guessed): the official Lookout Games
//    "1830: Railways & Robber Barons" rulebook, and the open-source
//    18xx.games engine's `lib/engine/game/g_1830/map.rb` (whose `HEXES`
//    table is a faithful digital reproduction of the physical board and
//    was fetched directly for this pass). Every `label` below (e.g.
//    `"G19"`) is the board's own printed coordinate, included specifically
//    so this data can be independently re-checked against those sources.
//    COORDINATE TRANSFORM: the physical board uses row-letter + column-
//    number labels (`layout: pointy`, `axes: {x: :number, y: :letter}` in
//    18xx.games' engine), which convert to this file's axial `(q, r)` via
//    `r = index of the row letter (A=0 .. K=10)` and
//    `q = (columnNumber - 1 - r) / 2`
//    (always an integer, since column parity alternates by row on the real
//    board) -- this reproduces the engine's own `DIRECTIONS[:pointy]`
//    adjacency table exactly. IMPORTANT CORRECTION: an earlier request for
//    this feature specified off-board/city coordinates (Canadian Pacific
//    "B2", Maritime Provinces "F2", South/Gulf "K13", New York "H12",
//    Boston "K6", Baltimore "G15") that were checked against both sources
//    above and do NOT match the real board -- e.g. F2 is actually Chicago,
//    H12 is Altoona (the Pennsylvania RR's home city), K6 and B2 aren't
//    real hexes on this board at all, and G15 is a plain mountain hex, not
//    Baltimore. `STATIC_BOARD_HEXES`/`LANDMARK_HEXES` below use the
//    verified real coordinates instead (New York = G19, Boston = E23,
//    Baltimore = I15, and all seven real red off-board hexes: Chicago F2,
//    Canadian West A9+A11, Gulf I1+J2, Deep South K13, Maritime Provinces
//    B24) -- see `OFFBOARD_LABELS` below for the full, corrected set.
//    CROSS-FILE CONSISTENCY: RESOLVED. A follow-up pass updated the Rust
//    backend's `hexmap::LANDMARK_HEXES` (and added `hexmap::OFFBOARD_HEXES`)
//    to the same verified real coordinates this file already used --
//    New York `(6, 6)`, Boston `(9, 4)`, Baltimore `(3, 8)`, plus all seven
//    real off-board hexes. The on-chain reserved landmark/off-board hexes
//    and what players see on screen now agree; this file's own coordinates
//    were the source of truth that pass aligned the backend to, and were
//    left unchanged here. SIMPLIFICATION
//    NOTE: the real board also distinguishes "gray" (pre-printed, fixed,
//    non-upgradeable track) hexes and per-edge impassable borders from
//    ordinary blank hexes; neither distinction is modeled here -- both
//    collapse to this file's plain `"Plain"` background type, since this
//    layer only ever needed to communicate terrain (Plain/Mountain/River/
//    RedOffboard), not the full tile-upgrade rule set. Purely cosmetic
//    either way: none of `STATIC_BOARD_HEXES` carries game rules (no cost,
//    no connectivity) and none of it is sent to or read from the chain.
// 6b. **Pre-Printed Track Realism.** A previous pass rendered a laid
//    landmark hub tile using the *generic* connection bitmask renderer --
//    `hexmap::TILE_CATALOG`'s tile 10/13/14 all use `0b11_1111` (all six
//    edges), a deliberate contract-side simplification (see `hexmap.rs`'s
//    module doc comment #2), so that generic path drew a full 6-spoke star
//    at every landmark regardless of which city it was.
//    UPDATE (design note #118): those three old internal ids no longer
//    exist, and the tray catalog that replaced them is far less uniform --
//    of the four real `MajorCityHub` tiles, only #63 is still all-six-edges
//    (#57 is two edges, #14 and #15 are four). The conclusion below is
//    UNCHANGED and now rests on firmer ground rather than weaker: a
//    landmark's authentic pre-printed track was never a function of
//    whichever hub tile happens to sit on it, which is why
//    `LANDMARK_TRACKS` is consulted unconditionally and the per-tile
//    `drawTrackPath` call is skipped entirely at a landmark hex. Real
//    1830's three
//    home cities are NOT identical, and their track is *pre-printed on the
//    physical board itself* -- not something a player lays -- so
//    `LANDMARK_TRACKS` below hardcodes each city's own authentic, fixed
//    starting connections and renders them unconditionally in the landmark
//    background pass (visible from game launch, independent of whether
//    `mapGrid.tiles` happens to contain an entry there), while the laid-tile
//    loop now skips its generic track renderer entirely for any tile sitting
//    at a landmark hex (it still draws that tile's terrain fill/color-tier
//    outline, so a color-tier upgrade remains visible).
//    LANDMARK TRACK REALIGNMENT (corrects an earlier pass's edge numbers):
//    the first version of this table was built by matching 18xx.games'
//    pointy-top `DIRECTIONS` compass LABELS (their documented default
//    0=NW,1=W,2=SW,3=SE,4=E,5=NE) against this file's own compass labels
//    (0=E,1=NE,2=NW,3=W,4=SW,5=SE, design note #1) -- i.e. "their NW is our
//    NW, so translate by name." That assumption turned out to be false for
//    1830 specifically: 1830 configures its own `axes` differently from
//    the engine's stated default, which flips which physical direction
//    each of *their* numeric edge indices actually points to on the real
//    printed board. Caught by an independent sanity check: computing New
//    York (G19)'s six neighbors under this file's own axial system found
//    that our edges 0 (E) and 5 (SE) point at axial coordinates with NO
//    real hex in `STATIC_BOARD_HEXES` at all -- impossible for a city
//    hex that isn't on the board's edge, and a strong signal the
//    compass-label bridging was wrong. RE-VERIFIED against real, NAMED
//    neighboring hexes instead of compass labels (18xx.games'
//    `LOCATION_NAMES`/`HEXES` tables): New York (G19)'s two disconnected
//    stubs point toward F20 ("New Haven & Hartford", the New England
//    direction -- our edge 1/NE) and H18 ("Philadelphia & Trenton" -- our
//    edge 4/SW), the well-known real "one hex, two independent stations"
//    NYC design (one station serving New England, the other serving
//    Philadelphia and points south). Boston (E23)'s through-route connects
//    D24 (chains toward the Maritime Provinces off-board -- our edge 1/NE)
//    and F24 ("Mansfield", chaining to "Providence" -- our edge 5/SE) --
//    this one happened to survive the flawed compass-label translation
//    unchanged, since {NE, SE} is symmetric under the axis flip that broke
//    New York and Baltimore. Baltimore (I15)'s through-route connects I17
//    (bordering Philadelphia -- our edge 0/E) and J14 ("Washington" --
//    our edge 4/SW), matching 1830's well-known Baltimore/Washington/
//    Philadelphia corridor. SOURCES (cross-verified against 18xx.games'
//    `lib/engine/game/g_1830/map.rb` tile-definition strings AND its
//    `LOCATION_NAMES`/`HEXES` tables for the real neighbor cross-check,
//    the same engine cited in note #6): New York is
//    `'city=revenue:40;city=revenue:40;path=a:3,b:_0;path=a:0,b:_1'`,
//    Boston is `'city=revenue:30;path=a:3,b:_0;path=a:5,b:_0'`, Baltimore
//    is `'city=revenue:30;path=a:4,b:_0;path=a:0,b:_0'`. LIMITATION: this
//    only models each city's *starting* (Yellow-equivalent) track -- real
//    1830's Green/Brown city-tile upgrades change a home city's printed
//    track further, which isn't researched or modeled here; an upgraded
//    landmark still renders its starting-track shape, just recolored via
//    `COLOR_TIER_STROKE`.
// 6c. **Safe text background box.** Every label pass (`fitFontSize`
//    responsively shrinks the font, per note #3b, but that alone doesn't
//    stop a legibly-sized label from visually colliding with a track stroke
//    or another hex's fill drawn underneath it) now also routes through
//    `drawLabelWithBackground`, which paints a small translucent rounded
//    rectangle sized to the actual measured text before drawing the text
//    itself -- so a landmark name or off-board zone name always has a clean
//    patch of contrast behind it regardless of what's drawn beneath.
// 7. **Interactive Floating Tile-Selection Popup Overlay** -- click
//    interceptor, live preview, and dispatch live in three places by
//    design, not by accident: (a) this file owns pixel->axial conversion
//    AND actually firing the read-only `GetLegalTilePlacements` query
//    itself (via the optional structurally-typed `queryClient` prop, so
//    this file still never imports `@cosmjs/*` and stays usable with zero
//    wallet/session dependency when those props are omitted) -- see
//    `handlePointerUp`'s click-vs-drag distance check and
//    `onHexClick`/`onHexClickQuery`; (b) the floating card itself
//    (`TileSelectionPopup.tsx`) and all of `App.tsx`'s wiring live outside
//    this file, consistent with the established "HexGridRenderer is
//    presentational, App.tsx owns wallet/session wiring" split documented
//    in `App.tsx`'s own comments; (c) the "live map preview" is just this
//    file's `previewTile` prop plus one more drawing pass in `draw()` --
//    the actual rotation-cycling UI/state lives in `TileSelectionPopup.tsx`.
//    ORIENTATION IS A REAL, BINDING CHOICE (STRUCTURAL FIX -- supersedes an
//    earlier pass of this note): `ExecuteMsg::LayTile` (see `msg.rs`) now
//    takes an explicit, required `orientation` field, and
//    `hexmap::execute_lay_tile` commits *exactly* that submitted rotation
//    (rejecting the call outright if that specific angle isn't legal) --
//    it no longer auto-picks the lowest legal orientation on the caller's
//    behalf. A prior version of this contract had no `orientation` input
//    at all, which silently removed a genuine 1830 strategic decision
//    (which direction a route extends); that auto-pick has since been
//    removed. So the orientation-cycling control `TileSelectionPopup.tsx`
//    exposes is a real choice, not just a preview: whichever legal
//    orientation is selected when "Confirm Placement" is clicked is
//    exactly what gets laid on-chain.
// 8. **Camera Bounds & Zoom Clamping.** `MIN_ZOOM` used to be a flat `0.3`
//    constant -- a player could zoom out to roughly 3x further than the
//    board itself, surrounding it with a large empty margin. The minimum
//    zoom is now DERIVED, not hardcoded: `minZoom` (a `useMemo`) is
//    exactly the zoom level that frames the entire real board (every
//    `STATIC_BOARD_HEXES`/`LANDMARK_HEXES` hex) with a small 10% margin --
//    the same "fit the whole board" computation the one-shot auto-fit
//    (design note #5) already used, now also reused as the live floor for
//    `handleWheel`. This is deliberately computed from `hexSize`/`width`/
//    `height` rather than a magic number, so it stays correct if any of
//    those props ever change (a fixed `0.8`/`1.0` would silently be wrong
//    for a differently-sized canvas or a resized hex); for this file's own
//    defaults (`hexSize=42`, `900x640`) it happens to evaluate to ~0.81,
//    squarely in the range this feature's request suggested. Panning is
//    now bounds-clamped too, via `clampPanToBoard`/`panClampRange`: a
//    single reflected-min/max formula handles both the "zoomed in, board
//    bigger than the viewport" case (keep the viewport inside the board)
//    and the "zoomed out, board smaller than the viewport" case (keep the
//    board inside the viewport) without branching, applied on every
//    `handlePointerMove` drag step and every `handleWheel` zoom step (a
//    zoom change can itself push a previously-valid pan out of bounds).
//    `boardContentBounds` (the board's own unscaled footprint) is
//    memoized on `hexSize` alone, deliberately NOT on `mapGrid.tiles` --
//    the clampable/fittable area is the fixed physical board, not
//    whatever happens to be laid on it yet.
// 9. **Buildable Terrain Icons vs. Ocean.** A previous pass rendered River
//    hexes with a solid blue fill (`#2f5a7a`) and Mountain hexes with a
//    solid brown fill -- both real, LAYABLE terrain in 1830 (a river
//    crossing or mountain pass tile can be built there, at a terrain
//    cost), but the solid, non-land fill colors visually read as
//    impassable obstacles instead. River and Mountain hexes now use the
//    SAME land fill as an ordinary Plain hex (`BOARD_HEX_FILL`), with the
//    terrain communicated instead by an icon -- `drawRiverIcon`'s blue
//    vector-line stroke, or `drawMountainIcon`'s brown twin-peak triangle
//    -- plus a representative build-cost label (`TERRAIN_BUILD_COST_LABEL`:
//    $80 river / $120 mountain, the real 1830 printed terrain costs for
//    these two terrain types), rendered with the same safe text-background
//    treatment as every other label here (design note #6c). A prior pass
//    briefly added a genuinely unbuildable "Ocean" `BoardHexType` for the
//    real A13/A15 gap (row A has no hex at columns 13/15) plus a decorative
//    ocean/lake backdrop elsewhere on the canvas -- both fully removed, see
//    design note #18.
// 10. **Pre-Printed Off-Board Track.** Every one of the seven red off-board
//    revenue hexes (`OFFBOARD_HEXES`/`OFFBOARD_LABELS`) previously rendered
//    with zero track at all -- just a red box and a name. Real 1830's
//    off-board hexes have printed track stubs where the line runs off the
//    edge of the board toward that destination. `OFFBOARD_TRACKS` fixes
//    this, SOURCED directly from the open-source 18xx.games engine's
//    `lib/engine/game/g_1830/map.rb` (github.com/tobymao/18xx), fetched
//    for this pass -- e.g. Chicago (F2) is
//    `'offboard=revenue:yellow_40|brown_70;path=a:3,b:_0;path=a:4,b:_0;
//    path=a:5,b:_0'`. Their raw edge numbers were translated into this
//    file's own edge convention (design note #1) via the SAME verified
//    reflection this file already derived for the three landmark cities
//    (design note #6b): `our_edge = ((4 - their_edge) % 6 + 6) % 6`.
//    RE-VERIFIED independently here (not just trusted from #6b): every
//    single one of the 7 hexes' translated edges was checked against
//    `HEX_NEIGHBOR_OFFSETS` and confirmed to land on a REAL, existing
//    `STATIC_BOARD_HEXES` entry (e.g. Chicago's three edges resolve to the
//    real neighbors F4/E3/G3; Maritime Provinces' two edges resolve to
//    B22/C23) -- the same "does this edge point at a real hex, or empty
//    space" red-flag check that originally caught the landmark bug, now
//    passing cleanly for all 7 hexes with zero exceptions, which is strong
//    corroborating evidence the reflection formula generalizes correctly
//    beyond the 3 cities it was derived from. `drawOffboardTrack` reuses
//    `drawLandmarkTrack`'s edge-to-stub geometry but deliberately omits its
//    station circle -- an off-board hex is a revenue destination, not a
//    real station.
// 11. **Phase-Dependent Off-Board Value Plates.** `OFFBOARD_REVENUE` adds
//    each off-board destination's real printed revenue, also sourced from
//    the same `map.rb` fetch (e.g. Chicago is
//    `revenue:yellow_40|brown_70`). Real 1830's off-board boxes print
//    BOTH tiers on the physical cardboard up front (`"$40/$70"`-style),
//    rather than a single value that changes as the game progresses --
//    this mirrors that directly, alongside the destination name, both
//    behind `drawLabelWithBackground`'s safe box (design note #6c) so
//    neither collides with the pre-printed track stubs behind them. NOTE:
//    off-board hexes only ever have two tiers here (Yellow/Brown, no
//    distinct Green value) -- confirmed from the same source, not an
//    omission. This is a purely cosmetic, board-authenticity label: this
//    contract has no `ExecuteMsg` for collecting off-board revenue at all
//    (`hexmap::OffboardHexNotBuildable` -- these hexes are permanently
//    unbuildable, not part of any Operating Round payout), so nothing here
//    reads from `GameSession::current_global_era` or any other live game
//    state, matching how the physical board itself is static printed
//    cardboard, not a dynamic display.
// 12. **Complete Map Topology & Named Hexes.** Design note #6's own
//    "SIMPLIFICATION NOTE" flagged that pre-printed gray hexes and their
//    per-edge track collapsed to the plain `"Plain"` background -- this pass
//    fixes exactly that gap, plus adds the pre-printed yellow "OO"
//    double-city hexes that were entirely unmodeled before. SOURCE
//    (verbatim-fetched, cross-checked byte-for-byte across two independent
//    mirrors -- raw.githubusercontent.com and github.com/blob -- for this
//    pass): `tobymao/18xx`'s `lib/engine/game/g_1830/map.rb`, specifically
//    its `HEXES` hash's `gray:`/`yellow:` blocks and its `LOCATION_NAMES`
//    table. `GRAY_HEXES` covers all twelve real pre-printed gray hexes
//    (Lansing D2, Cleveland F6, a bare connector E9, Altoona H12, Rochester
//    D14, Kingston C15, Richmond K15, a bare connector A17, Montreal A19,
//    Atlantic City I19, Mansfield F24, a bare connector D24); `YELLOW_OO_HEXES`
//    covers the four real pre-printed yellow double-city hexes (Detroit &
//    Windsor E5, Hamilton & Toronto D10, Dunkirk & Buffalo E11, Philadelphia
//    & Trenton H18) -- New York/Boston/Baltimore are ALSO real pre-printed
//    yellow hexes per this same source, but were already modeled with their
//    own more detailed `LANDMARK_HEXES`/`LANDMARK_TRACKS` system (design
//    note #6b) before this pass, so their TRACK/label/name system is
//    deliberately left as-is rather than folded into the new, simpler gray/
//    yellow-OO systems. UPDATE (color calibration pass, "Unify All Board
//    Yellow Shades"): their FILL COLOR specifically has since been folded
//    in after all -- `STATIC_BOARD_HEXES`'s own G19/E23/I15 entries now
//    carry `printedColor: "Yellow"` too, so they share the exact same
//    `PRINTED_HEX_FILL.Yellow` paint as every OO hex instead of the
//    separate translucent per-city tint `LANDMARK_FILL` used to apply (see
//    the landmark-shading pass's own comment below for the full rationale)
//    -- only their track/label/name modeling stays on the separate,
//    detailed system this note originally described. Every gray/yellow
//    hex's translated edges were spot-checked the same way design note #10
//    already established for off-board hexes (does each translated edge
//    point at a real, existing `STATIC_BOARD_HEXES` neighbor?) before being
//    committed to `GRAY_HEXES`. `BoardHex.printedColor` composes with the
//    EXISTING `type` field rather than replacing it (see that field's own
//    doc comment) specifically so a hex like Detroit & Windsor (E5) can be
//    both a pre-printed yellow city AND a River hex with its existing river
//    icon/cost label -- both are simultaneously true on the real board.
// 13. **100% Fit-to-Page Camera Toggles.** The camera used to always allow
//    free pan/zoom (clamped to the board, per design note #8, but always
//    live). It's now a two-state toggle: the DEFAULT baseline pose is
//    always exactly `fitView` -- the same "frame the whole board" zoom/pan
//    computation design note #8 already derived (`minZoom`, centered on
//    `boardContentBounds`), now also enforced as a HARD lock, not just a
//    floor -- `detailedView === false` makes `handlePointerMove`/
//    `handleWheel` both no-ops (see their own inline comments), so the
//    player literally cannot pan or zoom away from the full-board view
//    until they opt in. Clicking the new "Toggle Detailed View" button (an
//    on-canvas `<button>`, absolutely positioned over a newly-added wrapping
//    `<div>` -- the component's root element used to be the bare `<canvas>`
//    itself, which had no room to host DOM UI on top of it) flips
//    `detailedView` on, jumps the camera to a fixed closer zoom
//    (`minZoom * 1.8`, floored at `minZoom + 0.6` so a very small board/
//    `minZoom` still produces a noticeably closer view), and enables both
//    handlers; clicking it again snaps the camera back to exactly `fitView`
//    and re-locks them. NOTE on "100%": this feature's own name calls the
//    locked baseline a "100% view scale" -- that's interpreted here as "100%
//    of the board fits in the viewport" (i.e. `fitView`/`minZoom`), not a
//    literal canvas `zoom === 1.0`, since a literal `1.0` would only
//    coincidentally fit any particular `hexSize`/viewport combination
//    (exactly the same reasoning design note #8 already used to justify a
//    derived, non-hardcoded zoom floor over a magic constant). The click
//    interceptor (design note #7) deliberately still works at baseline --
//    `handlePointerDown` always arms `dragStateRef` so `handlePointerUp`'s
//    click-vs-drag distance check keeps functioning either way; only the
//    actual pan/zoom mutation is gated on `detailedView`.
// 14. **Realistic Topographical Background (REMOVED -- see design note
//    #18).** This slot previously held `drawTopographyBackground`, an
//    illustrative real-world geography backdrop (Atlantic coastline plus
//    Lakes Erie/Ontario/Huron) drawn outside the board's own real edge.
//    Request F item 2 asked for exactly the opposite treatment -- a clean,
//    solid, neutral background outside the authentic 93-hex footprint, not
//    decorative geography -- so the whole function, its `hexDisk` helper,
//    and its call site were deleted outright rather than left as dead code.
//    Kept as a numbered note (not renumbered away) so this design-note
//    index stays stable for anything cross-referencing it.
// 15. **Adaptive Off-Board Tooltips.** Two related changes, both scoped to
//    the red off-board revenue hexes (design notes #6/#10/#11):
//    (a) each off-board hex now prints only ONE value inside itself --
//    whichever of `OFFBOARD_REVENUE`'s two real tiers applies at the room's
//    live `current_global_era` (the new `currentEra` prop, mirroring
//    `GameStateResponse.current_global_era` from `src/msg.rs`), via
//    `offboardValueForEra`, instead of the previous pass's always-both
//    "$40/$70" display. Real 1830 off-board boxes only ever print a Yellow
//    and a Brown figure (design note #11) -- there is no separate printed
//    Green number, so Green reuses the Yellow figure here exactly as it
//    does on the physical board. (b) hovering the pointer over an off-board
//    hex (tracked in `handlePointerMove`, independent of drag/`detailedView`
//    state so it works even at the locked 100% baseline -- see that
//    handler's own comments) now shows `drawOffboardTooltip`'s floating
//    card: the full Yellow/Green/Brown progression, color-coded per
//    `COLOR_TIER_STROKE`, with the currently active era's row bolded and
//    marked "ACTIVE". The card is a CANVAS-drawn element (not a DOM
//    overlay like the "Toggle Detailed View" button, design note #13) --
//    drawn in the same world-space transform as every other on-canvas
//    label in this file, so it pans/zooms consistently with the board
//    rather than needing a second, screen-space-fixed overlay system.
// 16. **Alphanumeric board margin labels.** `drawBoardMarginLabels` stamps
//    the real board's own row letters (A-K, one per axial row `r`) along
//    the left/right edges and the real board's own printed column numbers
//    (parsed straight off each hex's existing `label` field, e.g. `"G19"`
//    -> row G's letter plus column 19 -- not an invented 1/2/3 sequence)
//    along the top/bottom edges, so a player can locate any hex the same
//    way `describeHex`'s own labels already work everywhere else in this
//    file. `computeBoardMarginLabels` derives each label's position purely
//    from `axialToPixel` itself (a fixed row shares one pixel `y`
//    regardless of `q`; a fixed real column number shares one pixel `x`
//    regardless of which row's hex supplies it -- the reason the physical
//    board's rows/columns print as straight lines in the first place), so
//    it can never drift out of sync with design note #1's own conversion.
//    Drawn LAST in `draw()`'s world-space pass (after even the ghost
//    preview and off-board tooltip), using the same `drawLabelWithBackground`
//    safe-contrast convention as every other label here (design note #6c).
//    `boardContentBounds`'s own padding was widened (from a flat `hexSize`
//    to `hexSize * 2.5`) so these margin labels are fully inside the
//    default locked `fitView` pose (design note #13) rather than clipped at
//    the canvas edge. A follow-up pass straightened these labels onto one
//    consistent bounding line per side -- see the note directly above
//    `computeBoardMarginLabels` for the full before/after.
// 17. **Visual sweep: crisp ocean hex fills (since fully removed -- see
//    design note #18), and standalone "+"/"-"/"Fit to Screen" camera
//    buttons.** (a) previously repainted `drawTopographyBackground`'s water
//    bodies as crisp `hexDisk`-generated hex clusters instead of hand-tuned
//    curves; that entire background pass -- crisp or not -- is now gone
//    outright per Request F item 2. (b) The "Toggle Detailed View" button
//    (design note #13) was the only way to leave the locked `fitView`
//    baseline;
//    this pass adds three standalone camera-overlay buttons -- "+"/"-"
//    (`handleZoomStep`, zooming around the canvas's own screen-space
//    center, since a button click has no cursor position to anchor on
//    unlike `handleWheel`'s mouse-anchored zoom) and "Fit to Screen"
//    (`handleFitToScreen`, an explicit, idempotent snap back to exactly
//    `fitView`) -- stacked bottom-right so they never collide with the
//    existing top-right toggle. Each of the three works standalone: "+"/
//    "-" flips `detailedView` on itself if the camera is still at the
//    locked baseline (rather than being a no-op until the separate toggle
//    is clicked first), and "Fit to Screen" always re-locks it, regardless
//    of whether the camera got to its current pose via drag/wheel or these
//    new buttons.
// 18. **Authentic-footprint-only board (Request F item 2).** Removed every
//    hex/decoration that wasn't one of the real 93 board hexes: the two
//    fake `A13`/`A15` "Ocean" gap-filler entries (a prior pass's stand-in
//    for a real gap that simply has no hex there -- see `STATIC_BOARD_HEXES`'s
//    own comment) and `drawTopographyBackground`'s entire decorative
//    ocean/lake hex-cluster backdrop (design notes #14/#17a), including its
//    `hexDisk`/`OceanClusterAnchor` helpers and its call site in `draw()`.
//    The `Ocean` `BoardHexType` variant and its `BOARD_HEX_FILL`/
//    `BOARD_HEX_STROKE` entries were deleted too, since nothing uses them
//    anymore. `draw()`'s base `ctx.fillRect` -- the color that now shows
//    through everywhere outside the real board footprint, including A13/A15's
//    genuine gap -- changed from a dark green (`#0e1a12`) to a neutral dark
//    charcoal (`#141414`), matching this item's explicit "clean, solid,
//    neutral dark charcoal/black background workspace" requirement.
// 19. **Viewport maximization (Request F item 3).** `width`/`height` are no
//    longer required props with fixed pixel defaults (`DEFAULT_WIDTH = 900`/
//    `DEFAULT_HEIGHT = 640`) -- when omitted, this component now measures
//    its own wrapping `<div>` via `ResizeObserver` and uses that live size
//    instead, so the canvas fills 100% of whatever workspace pane hosts it
//    (see `App.tsx`'s `boardPane`, changed to stretch its child rather than
//    center a fixed-size one). No separate "auto-scale hex radii" logic was
//    needed: `minZoom`/`fitView` (design note #8) already compute
//    `Math.min(width / boundsWidth, height / boundsHeight)`, so a larger
//    measured viewport already yields a larger fit zoom, and every hex
//    (`hexSize * zoom` on screen) scales up automatically as the panel
//    grows -- this item's "automatically scaling up hex radii" requirement
//    was really asking for real width/height to reach that existing
//    formula, not a second scaling system.
// 20. **Margin labels locked to the panel frame (Request F item 4)
//    (SUPERSEDED -- see design note #25).** `drawBoardMarginLabels` (design
//    note #16) -- the canvas world-space draw pass that painted row
//    letters/column numbers -- was removed from `draw()` entirely (and
//    deleted, being now dead code at the time). The row/column labels were
//    still computed by `computeBoardMarginLabels` (unchanged, still pure
//    geometry), but rendered as a `position: absolute` CSS/DOM overlay
//    (`MarginLabelsOverlay`, `pointerEvents: "none"`) sized off the LOCKED
//    `fitView` transform rather than the live, possibly-panned/zoomed
//    `view` -- so the labels always sat at fixed pixel positions relative to
//    the outer panel frame and never moved during a pan/zoom drag, matching
//    that item's "fixed, permanently visible ... locked directly to the
//    outer edges" requirement literally. Design note #25 reverses this
//    entire DOM-overlay approach back to native canvas text -- see there.
// 21. **Active coordinate hover tooltip (Request F item 5).** `handlePointerMove`
//    already computed the hovered axial `(q, r)` every frame for the
//    off-board-tooltip feature (design note #15b); it now also resolves that
//    same `(q, r)` to a board-label string (reusing `describeHex`'s own
//    landmark/off-board/plain-hex resolution) and stores it alongside the raw
//    `clientX`/`clientY`, in a new `hoveredCoordLabel` state. A small `position:
//    fixed` DOM tooltip near the cursor renders "Hovering: <label>" whenever
//    that state is non-null (i.e. only while the pointer is over a real hex
//    of the authentic board -- silent over the now-plain charcoal background
//    outside it, per design note #18, since there's nothing to report there).
// 22. **Off-board revenue badges + a factual correction (Request F item 6).**
//    Each off-board hex's active-value text (design note #15a) is now paired
//    with a small circular color-coded badge (fill = `COLOR_TIER_STROKE[currentEra]`,
//    i.e. gold/green/brown matching the same era colors used elsewhere in
//    this file) drawn just below/right of the zone name plate, with the name
//    plate itself pushed up slightly further from hex center -- both purely
//    to satisfy this item's "circular value badge ... explicit offset padding
//    ... never overlap tracks" ask. The underlying `OFFBOARD_REVENUE` NUMBERS
//    were deliberately left unchanged: Request F's own item 6 text asserted a
//    3-tier Yellow/Green/Brown progression with specific figures (e.g. Deep
//    South 40Y/70G/100B), but this project's own design note #11 already
//    documents -- and a fresh re-verification pass against `tobymao/18xx`'s
//    `lib/engine/game/g_1830/map.rb` this session re-confirmed -- that the
//    real board only ever prints TWO tiers (Yellow/Brown) per off-board box,
//    and the actual sourced numbers don't match the ones in the request
//    (real Deep South is `30Y/40B`, not `40Y/70G/100B`, for one). Implementing
//    the requested numbers verbatim would have replaced already-correct,
//    already-sourced data with incorrect data, so they were not applied --
//    see this session's final summary for the itemized discrepancy.
// 23. **Snapped map-frame border (SUPERSEDED -- see design note #24 for the
//    final, literal implementation).** A first pass at this geometry
//    request added a `boardFrameScreen` memo (a projected, letterboxed-inset
//    rect) plus a separately-positioned border div, deliberately avoiding a
//    literal `w-fit h-fit` container out of concern it would revert design
//    note #19's flex-fill viewport maximization. That concern, and the
//    approach it produced, are both superseded by note #24 below: the real
//    conflict was never "`w-fit h-fit` vs. viewport maximization" (those
//    turn out to be fully compatible, see #24), it was a `ResizeObserver`
//    circularity that a second, inner wrapper resolves cleanly. Kept here,
//    unrenumbered, purely so this design-note index stays stable for
//    anything cross-referencing it.
// 24. **Literal canvas-edge margin labels (corrects note #23).** The same
//    geometry request came back a second time, more specifically: remove the
//    `boardFrameScreen`-style projected/letterboxed frame tracking entirely,
//    wrap the `<canvas>` and its margin-label overlay in one shared
//    `position: relative; margin: 0 auto; width: fit-content; height:
//    fit-content` parent (this file's plain-`CSSProperties` translation of
//    the request's literal Tailwind `"relative mx-auto w-fit h-fit"`
//    example -- still no CSS framework here), and pin the row/column labels
//    to that parent's own immediate outer edges rather than an inset rect.
//    KEY INSIGHT that resolves note #23's stated concern: the `<canvas>`
//    DOM element already renders at exactly `width`x`height` (no DOM-level
//    letterbox gap -- design note #19's "empty space" is pixels drawn
//    *inside* the canvas by `fitView`'s zoom-to-fit, not empty space around
//    the canvas element itself), so a `w-fit h-fit` wrapper around the
//    canvas ends up exactly canvas-sized regardless -- `w-fit h-fit` and
//    100%-viewport-fill aren't actually in tension. The real hazard was
//    circularity: `containerRef` is what `ResizeObserver` measures to
//    compute `width`/`height` (design note #19); making THAT SAME div
//    `w-fit h-fit` would make its size depend on its canvas child, whose
//    size depends on measuring it -- a feedback loop that would freeze at
//    the `DEFAULT_WIDTH`/`DEFAULT_HEIGHT` fallback forever. Fixed by adding
//    a second, inner wrapper (styled via the new `MAP_FRAME_BORDER_STYLE`,
//    repurposed from note #23's border-only div into this full container
//    style) nested INSIDE `containerRef`: `containerRef` keeps flex-filling
//    the host pane and stays the `ResizeObserver` target exactly as before
//    (zero change to note #19's behavior), while the new inner div sizes
//    itself purely from its canvas child's explicit pixel `style.width`/
//    `style.height` -- a one-directional dependency, no loop. The old
//    `boardFrameScreen` memo and its separately-positioned border div are
//    deleted outright: framing the map is now a single static `border` on
//    the inner wrapper (it's already exactly canvas-sized, so no rect needs
//    computing or "tracking" at all). `marginLabelsScreen`'s `leftX`/
//    `rightX`/`topY`/`bottomY` fields (each a `hexSize`-derived world-space
//    inset, projected through `fitView` -- the "tracking loop" by name) are
//    removed the same way; the JSX now anchors row labels directly at
//    `left: 4` / `left: width - 4` and column labels at `top: 4` / `top:
//    height - 4` -- the canvas's own literal pixel edges, a few px in so
//    the centered label glyph (`MARGIN_LABEL_STYLE`'s `translate(-50%,
//    -50%)`) isn't clipped by the overlay's `overflow: hidden`. Each
//    label's OTHER axis (`row.y`/`column.x`) still goes through
//    `computeBoardMarginLabels` + the locked `fitView` projection -- that
//    part isn't optional tracking, it's the actual alignment math that
//    keeps row G's label level with row G's hexes; only the frame/inset
//    computation was redundant "loop" work, not the row/column alignment
//    itself.
// 25. **Native canvas coordinates + canvas bounding-box reset (SUPERSEDES
//    #20/#23/#24).** A comprehensive architectural refactor request asked
//    to strip out every DOM element built for the margin labels entirely --
//    text elements, wrappers, borders -- and draw the row/column labels
//    with `ctx.fillText` directly inside the canvas rendering loop instead,
//    "so coordinate axes automatically pan, zoom, scale, and align
//    perfectly... in real time," plus clean up any "trailing nested
//    wrappers or circular container size dependencies" so the map canvas is
//    "the direct, clean flex-filled center component of the viewport panel
//    window." This reverses notes #20/#23/#24's entire DOM-overlay
//    detour -- not because any of it was wrong on its own terms (each pass
//    correctly solved the DOM-positioning problem it was given), but
//    because moving the labels INTO `draw()`'s own canvas pass eliminates
//    that problem's premise altogether: `drawBoardMarginLabels` (restored,
//    with `computeBoardMarginLabels` restored to computing both axes again)
//    is now called at the very end of `draw()`'s existing
//    `ctx.translate(view.panX, view.panY)` / `ctx.scale(view.zoom,
//    view.zoom)` world-space transform -- the SAME transform every hex,
//    track, and other label in this file already draws through -- so
//    alignment with the live (not locked-baseline) `view` falls out
//    automatically, with no DOM position, no `fitView` projection, no
//    `ResizeObserver`-circularity concern, and no separate "frame" element
//    of any kind left to reason about. `MARGIN_LABEL_STYLE` and
//    `MAP_FRAME_BORDER_STYLE` are deleted outright, and the inner
//    `w-fit h-fit` wrapper div note #24 introduced is deleted too: JSX's
//    `containerRef` now wraps a bare `<canvas>` directly, once again "the
//    direct... center component" this item's own wording asked for.
//    `App.tsx`'s `boardPane`/`canvasPane` styles were reviewed against this
//    same "nested wrappers or circular dependencies" concern and left
//    unchanged -- `boardPane` already renders `<HexGridRenderer>` as its
//    one direct flex-stretched child with no extra nesting of its own, and
//    its size comes one-directionally from the surrounding flex layout, not
//    from anything inside `HexGridRenderer`, so there was nothing circular
//    there to begin with; the circularity this note resolves was always
//    internal to this file's own now-deleted inner wrapper.
// 26. **Camera tightening, value-enriched tooltip, Gulf merge, and value
//    badges (5-item mathematical/visual overhaul).** Five items, each
//    addressed independently:
//    (1) `boardContentBounds`'s `labelPadding = hexSize * 2.5` term and
//    `minZoom`'s `* 0.9` margin factor are both removed outright, per this
//    item's explicit "completely remove any large hardcoded pixel padding
//    or fractional window margin buffers" wording. The bound is now padded
//    by exactly `hexSize` -- NOT zero -- since `hexSize` is the hexes' own
//    real center-to-corner radius (see `pointOnCircle(center, size,
//    cornerAngleRad(i))` in `drawHexPath`); padding by anything less would
//    clip the outermost edge hexes' own corners, which is a hex-geometry
//    correctness floor, not a "large" cosmetic buffer. ACCEPTED TRADEOFF:
//    the native canvas margin-row/column labels (design note #25) are
//    still drawn at their own separate `labelOffset = hexSize * 1.15`
//    outside the hex extent, independent of this bound -- they are no
//    longer guaranteed full clearance inside the locked baseline `fitView`
//    now that its padding is 1.15x smaller than before, and may render
//    close to (or clipped at) the canvas edge at the default 100% view.
//    This is the direct, expected consequence of this item's own literal
//    instruction, not an oversight; flagged here rather than silently
//    keeping some padding to protect the labels instead.
//    (2) `HOVER_TOOLTIP_STYLE` roughly doubled (9px/16px padding, 20px
//    bold font, thicker border) and the "Hovering: " prefix dropped so the
//    on-screen text matches this item's own literal example exactly. The
//    tooltip content now comes from the new `describeHexWithValue`, which
//    appends `(Value: $X)` using either the new `hexRouteValue`/
//    `terrainBaseValue` (a frontend mirror of `hexmap::terrain_base_value`)
//    for ordinary/landmark/gray/yellow-OO hexes, or the EXISTING era-tiered
//    `offboardValueForEra` for the red off-board zones (a genuinely
//    different, already-era-varying value system -- see note #22).
//    (3) Gulf's two hexes (I1/J2) now render as one merged region: the
//    static-board fill/stroke pass calls the new `drawHexEdges` helper for
//    just these two labels, stroking their five OUTER edges individually
//    and skipping the one shared INTERIOR edge (I1's edge 5 / J2's edge 2,
//    confirmed via `edgeAngleRad`'s neighbor-direction math against
//    `OFFBOARD_TRACKS`'s own "real neighbor I3" comments, which land on
//    the same shared edge from both hexes). The off-board nameplate pass
//    was factored into a `drawOffboardNameplate` closure and is now called
//    ONCE for Gulf, centered at the I1/J2 midpoint, instead of once per
//    hex like every other off-board zone. Canadian West (A9/A11) has the
//    identical two-hex structure but wasn't part of this request, so it's
//    intentionally left unmerged.
//    (4) INVESTIGATED, NO BUG FOUND for the gray hexes: `drawPrintedTrack`
//    already positions its station/town marker exactly at the drawn
//    track's own endpoint in all three cases (a 1-edge stub's midpoint, a
//    2-edge segment's `center` -- which for the non-opposite/curved case is
//    literally the `arcTo` control point the curve bends through -- and a
//    3+-edge junction's shared `center`), and `drawStationCircle`'s filled
//    radius (`size * 0.22`) is comfortably larger than the track's own
//    stroke width (`size * 0.12`), so the marker fully covers the line's
//    end -- there is no floating/disconnected marker in code for Atlantic
//    City, Mansfield, Cleveland, Lansing, or Montreal. No code change was
//    needed or made for this half of the item. FACTUAL CORRECTION for the
//    yellow "OO" hexes (Detroit & Windsor, Dunkirk & Buffalo, Hamilton &
//    Toronto, Philadelphia & Trenton): this item asked for connecting
//    track between their two stations, but `drawOOCityMarkers`'s own doc
//    comment (from an earlier, already-verbatim-verified pass against real
//    source tile-definition data) documents that these four hexes
//    genuinely have NO printed `path=` connection on the real 1830 board --
//    that's their signature feature; a player must upgrade the tile to
//    connect the two stations. Fabricating a connection here would make
//    the map LESS accurate, so none was added; `drawOOCityMarkers` is
//    unchanged.
//    (5) A new `drawValueBadge` draws a small color-coded $-value circle
//    (amber `$10` for `SmallTown`, crimson `$20` for `MajorCityHub`,
//    palette in `VALUE_BADGE_COLOR`) at the upper-right corner of every
//    landmark, every gray hex with a city/town marker, every yellow-OO
//    hex, and any laid SmallTown/MajorCityHub tile. FACTUAL CORRECTION:
//    this item asked for a value "based on the current game phase tier,"
//    but `hexmap::terrain_base_value` (the actual backend rule
//    `RunManualRoute`'s payout math uses, mirrored here as
//    `terrainBaseValue`) is flat and terrain-only -- a hex's $ value never
//    changes as the game advances through color tiers, unlike the
//    genuinely era-tiered off-board badges (note #22). The two example
//    numbers this item gave ($10 towns / $20 base cities) DO match this
//    flat table and are used verbatim; what's NOT implemented is a second,
//    phase-varying value for the same hex, since the backend has no such
//    rule to mirror.
// 27. **Page-Level Scrolling & True Proportional Scale (item 1 of this
//    pass).** The structural calibration pass's `minZoom` fix (see the
//    comment above it) deliberately scaled the board to fill BOTH the
//    hosting pane's width AND height edge-to-edge, cropping whichever axis
//    didn't match the board's own aspect ratio -- which only reads as
//    "maximized" when that hosting pane itself is a small, viewport-clamped
//    box the player has to pan/zoom inside (see `App.tsx` design note #13
//    for exactly how that clamp cascaded down from `appRoot`'s `100vh`).
//    This pass removes that ceiling instead: `height` (previously taken
//    from the `ResizeObserver`'s own measured container height) is now
//    DERIVED from the board's true aspect ratio at the measured `width`
//    alone (see the `height` `useMemo` above `minZoom`), and `minZoom`
//    fits `width` alone for the same reason -- since `height` now always
//    matches `width`'s implied aspect ratio by construction, there is no
//    longer a mismatched viewport to crop against. The `<div>`/`<canvas>`
//    pair's own DOM height is set to that same derived pixel value (not
//    `"100%"`), so it's a real, definite box instead of a percentage that
//    would resolve to nothing once no ancestor imposes a height -- and that
//    real height is exactly what lets it cascade up through `App.tsx`'s now
//    fully un-clamped flex chain to the page itself, where the BROWSER's
//    own scrollbar takes over for whatever doesn't fit above the fold.
//    "Detailed View" (design note #13's zoom-in toggle) is untouched --
//    still lets a player zoom in past this baseline and pan within the
//    canvas's own fixed pixel bounds exactly as before.
// 28. **Inset Canvas Margin Labels (item 2 of this pass).** Design note #26
//    item 1's `labelOffset = hexSize * 0.93` only ever cleared the outermost
//    hex's own silhouette against the camera's `hexEdgePadding = hexSize`
//    visible boundary -- it never accounted for the fact that a drawn
//    label's own rendered box (`drawLabelWithBackground`'s text plus its
//    background padding) extends further still, past that anchor point, in
//    the direction the label reads. A 2-character label, or the background
//    box's own padding, could each eat into -- and exceed -- the ~0.07 *
//    hexSize of clearance that `0.93` left, silently slicing the label at
//    the visible edge exactly as this item reports. `computeBoardMarginLabels`
//    now takes the live `ctx` and measures the actual widest row-letter and
//    column-number label it's about to draw (`ctx.measureText`, using the
//    exact font `drawBoardMarginLabels` already sets before calling it) --
//    a real rendered size, not a guessed constant -- and folds that
//    half-extent, plus `drawLabelWithBackground`'s own background padding,
//    into a single inward `labelSafetyOffset` applied to all four margins,
//    so every label's own drawn box (not just its anchor point) stays
//    inside the camera's visible boundary.
// 29. **Reverted Track Rotation Matrix (item 3 of this pass).** The
//    structural calibration pass's item 5 (see the "CORRECTED" comments
//    still attached to `LANDMARK_TRACKS`/`GRAY_HEXES` below) replaced this
//    file's verified edge-reflection formula (`our_edge = ((4 - their_edge)
//    % 6 + 6) % 6` -- design notes #6b/#10, independently corroborated
//    against real named neighbor hexes for all 3 landmarks AND all 7
//    off-board hexes with zero exceptions) with a claimed direct IDENTITY
//    mapping, citing its own 470-edge cross-check. RE-INVESTIGATED this
//    pass, because the two claims directly contradict each other and this
//    file's own established discipline is to verify, not silently trust
//    either one: re-deriving New York's two stub edges under the identity
//    mapping puts one of them (edge 0/E) at axial `(7, 6)` -- label "G21",
//    which does NOT exist anywhere in `STATIC_BOARD_HEXES` (row G's real
//    hexes stop at G19, New York itself) -- the exact same "points at a
//    nonexistent hex" red flag design note #6b originally used to catch
//    the ORIGINAL reflection bug, now catching the IDENTITY claim instead.
//    A second, independent case confirms it: Montreal (A19)'s identity-
//    mapped edge 0/E lands on axial `(10, 0)` -- label "A21", also absent
//    (row A's real hexes stop at A19, Montreal itself) -- literally running
//    the track off the printed board's own eastern edge, matching this
//    item's own "running sideways into the ocean" description. Since
//    reflection is its own inverse, applying the SAME `(4 - e) % 6`
//    formula to the identity pass's current (buggy) stored edge values
//    exactly recovers the original, doc-verified-correct values (confirmed
//    by hand for New York/Boston/Baltimore against this file's own prior
//    "New York was `[1]`/`[4]`, Boston was `[1, 5]`" record) -- so that's
//    what this pass applies, to both `LANDMARK_TRACKS` (all 3 landmarks)
//    and, since the identity bug was table-wide, ALL TWELVE `GRAY_HEXES`
//    entries, not just the 5 this item named by city -- reverting the other
//    7 (the unnamed connectors and Altoona/Rochester/Kingston/Richmond)
//    would leave them on the same broken formula for no principled reason.
//    Each reverted hex's own inline comment below shows the before/after
//    edge values and which of the two red-flag checks (or simple algebra)
//    confirmed it.
// 30. **Unified Board Yellow Shades (color calibration pass, item 1).** The
//    three landmark hexes (New York/Boston/Baltimore) used to get a
//    translucent per-city tint (`LANDMARK_FILL` -- red/blue/green at ~20%
//    alpha) painted over their ordinary cream `BOARD_HEX_FILL.Plain` base,
//    visually distinct from every other real pre-printed yellow hex on the
//    board (the OO double-city hexes). Design note #12 already established,
//    from the same sourced data as those OO hexes, that these three ARE
//    real pre-printed yellow hexes too -- so `STATIC_BOARD_HEXES`'s own
//    G19/E23/I15 entries now carry `printedColor: "Yellow"` exactly like an
//    OO hex, which routes them through the SAME static-background fill pass
//    and the SAME shared `PRINTED_HEX_FILL.Yellow` constant, rather than a
//    separate color system -- genuinely "the exact same... fill color", not
//    just a matching hex string. FACTUAL CORRECTION: this item's own
//    suggested `#FFCC00` example does not match this file's actual OO/
//    catalog yellow anywhere -- `PRINTED_HEX_FILL.Yellow` is `#e8d488`, a
//    deliberately muted "cardstock" gold (design note #12's own stated
//    intent), not a bright saturated color, and no bright/saturated yellow
//    fill exists anywhere else in this file to match. Using the literal
//    `#FFCC00` value instead would have introduced a FOURTH distinct
//    yellow shade rather than unifying to the one the OO hexes already
//    share -- so this pass points landmarks at that real shared constant
//    instead, which is what actually delivers this item's own stated goal
//    of "a uniform visual look across the map." The landmark-shading pass's
//    dashed white outline (a separate, deliberate "this hex is a landmark
//    station" indicator, unrelated to fill color) is unchanged; only its
//    own redundant re-fill is removed.
// 31. **Axis Text Boundary Inset -- re-verified (item 2).** Re-checked
//    design note #28's `ctx.measureText`-based inset after this pass's own
//    page-scrolling change (design note #27): the inset math is purely in
//    canvas world-space/coordinate terms and doesn't depend on the DOM
//    page's own scroll behavior, so it needed no change for that reason.
//    Tightened one real imprecision found during the re-check:
//    `computeBoardMarginLabels` now takes `drawBoardMarginLabels`'s actual
//    `fontSize` (`Math.max(11, hexSize * 0.3)`) as an explicit parameter,
//    instead of re-deriving an un-floored `hexSize * 0.3` locally -- at a
//    small enough `hexSize` the `11`px floor dominates, and the un-floored
//    version would have understated the label's real rendered size (and so
//    its real half-extent) by that amount. `BACKGROUND_PADDING_PX = 4` and
//    the overall `hexEdgePadding - (halfExtent + padding)` formula are
//    otherwise confirmed correct: at the default `hexSize = 42`, the
//    resulting inset comfortably clears both a label's measured text width
//    and its background box, with `hexEdgePadding` itself exactly matching
//    `boardContentBounds`'s own camera-fit padding (design note #27), so
//    there is no longer a mismatched-viewport crop (design note #27) that
//    could tighten the effectively visible boundary further than this
//    function already accounts for.
// 32. **Unified City Center Station Fills -- re-verified, no discrepancy
//    found (this pass, item 1).** This item reported that pre-printed
//    yellow "OO" hexes (design note #12, `YELLOW_OO_HEXES`) draw bright
//    white station-circle fills while the three landmark hub cities (New
//    York/Boston/Baltimore) draw dark/transparent centers. Traced every
//    circle-drawing call site in this file before touching anything:
//    `drawOOCityMarkers` (the OO hexes' two independent stations),
//    `drawLandmarkTrack` (both the 2-edge through-route case, Boston/
//    Baltimore, and the 1-edge stub case, New York's own two disconnected
//    stations), `drawPrintedTrack`'s `marker === "city"` case (the gray
//    hexes' own city markers), and the laid-tile `MajorCityHub` case in the
//    generic multi-spur renderer -- EVERY one of these five call sites
//    calls the exact same shared `drawStationCircle` helper, which paints
//    an unconditional solid `#ffffff` fill with a `#2b2b2b` stroke; there is
//    no second, differently-colored circle-drawing path anywhere in this
//    file. So per the current source, landmark station centers and OO
//    station centers were already pixel-identical white fills before this
//    pass touched anything -- no color-mismatch code path exists to fix.
//    (Landmark hexes ALSO already share the OO hexes' exact hex-fill
//    treatment more broadly, from design note #30's earlier "Unified Board
//    Yellow Shades" pass.) FLAGGING rather than silently no-op'ing: if a
//    visual mismatch is still visible in a running build, it is not
//    reproducible from this file's source as it stands, which points at a
//    stale/cached bundle rather than a real code defect -- worth a hard
//    browser refresh / rebuild before assuming this item is unresolved.
//    Item 2's gold `parGroupFrame`-equivalent note doesn't apply here (that
//    was a StockMarketRenderer.tsx item); this file has no separate overlay
//    frame to preserve for this item.
// 33. **Transparent Coordinate Margin Fills (this pass, item 2).** Also
//    re-verified rather than taken at face value: `drawBoardMarginLabels`'s
//    row-letter/column-number labels were drawn through the same
//    `drawLabelWithBackground` convention (design note #6c) as every other
//    label in this file, whose DEFAULT background is a translucent WHITE
//    box (`rgba(255, 255, 255, 0.72)`), not literal solid black -- so this
//    item's exact color description didn't match the source. The
//    UNDERLYING complaint is still real and is what this pass fixes: any
//    background box at all behind these labels reads as the "ugly block
//    outline frame" this item describes, since the margin band sits over
//    one uniform solid fill (this component's `#141414` charcoal workspace,
//    design note #18) where a contrast box was never earning its keep the
//    way it does for labels sitting over busy hex art. `drawLabelWithBackground`
//    gained a new `background?: boolean` option (default `true`, so every
//    OTHER call site -- city/landmark names, cost labels, off-board
//    nameplates, era-tier cards -- is completely unaffected); only
//    `drawBoardMarginLabels`'s four label calls now pass `background:
//    false`, so no box is drawn there at all -- fully transparent, per this
//    item's literal ask. CONSEQUENCE CAUGHT AND FIXED: the margin labels'
//    text color, `#1a2e1f` (dark green), was only ever legible against that
//    now-removed white box -- against the actual `#141414` charcoal
//    underneath, dark green on near-black has effectively no contrast at
//    all. Left unchanged, this item would have made the coordinate labels
//    functionally invisible rather than "floating cleanly" as asked, so the
//    text color was also switched to a bright `#f0f0f0`, matching this
//    file's existing light-on-dark convention (e.g. the off-board
//    nameplate's `#ffe0e0` text over its own dark box).
// 34. **Tab-Switching Camera Guard + Complete 1830 Baseline City Database.**
//    Item 1: the `ResizeObserver` callback's zero-size guard was `< 1`,
//    which only caught a literal zero -- switching this component's tab
//    away and back (a re-render toggling the host pane's display, not an
//    unmount) can report a transient SINGLE-DIGIT pixel `contentRect` for
//    one observation mid-swap, comfortably past that old gate, collapsing
//    `measuredSize` (and the whole camera fit) down to it. Widened to
//    `<= 10`; simply `return`ing without calling `setMeasuredSize` already
//    IS "preserve last known valid settings" -- no separate "remembered"
//    state was needed. Item 2: added eight real 1830 city hexes via a new
//    `BoardHex.cityDesignation` field (the city-marker counterpart to the
//    existing `townDesignation` pattern) -- white station circle (the same
//    shared `drawStationCircle` every other real city marker in this file
//    uses), name tag, and the SAME flat `MajorCityHub` $20 value badge
//    `townDesignation` hexes already get, at F4 (Toledo), F22 (Providence),
//    H10 (Pittsburgh), H4 (Columbus), J14 (Washington), H16 (Lancaster),
//    B16, and B10 (Barrie). SOURCE VERIFICATION (independently re-derived
//    three separate times against `tobymao/18xx`'s `g_1830/map.rb` raw
//    source text, this file's own established sourcing convention -- design
//    notes #6/#12): all requested coordinates and terrain types (including
//    F4/F22/J14's pre-existing `River` type, which already carries the
//    correct $80 water-upgrade cost label from design note #9's existing
//    terrain-icon pass, unchanged) check out -- EXCEPT two of this item's
//    own specifics, which the source does not support and were NOT applied:
//    (1) B16's real name is Ottawa, not "Barrington" -- no hex named
//    "Barrington" appears anywhere in the source; used Ottawa instead.
//    (2) F24's real name is Mansfield (already correctly modeled since
//    design note #12, itself independently sourced) -- no hex named "River
//    Falls" appears anywhere in the source, so F24 was NOT renamed; kept as
//    Mansfield. Also caught and fixed a real label-collision bug this item
//    exposed: `NAMED_HEX_LABELS`' name-label pass and the River/Mountain
//    terrain-icon pass's cost-label both drew at the identical
//    `center.y + hexSize * 0.6` point, so a named River hex's name would
//    silently paint over its own "$80" cost label (already true, unnoticed,
//    for Detroit & Windsor/Hamilton & Toronto before this pass; now also hit
//    by Toledo/Providence/Washington) -- the cost label now shifts to
//    `0.85` whenever a name applies, so both stay independently legible.
//    Item 3: `computeBoardMarginLabels`/`boardContentBounds` derive their
//    bounds purely from each hex's already-fixed `(q, r)` (design note #16)
//    -- this pass added FIELDS to eight already-existing `STATIC_BOARD_HEXES`
//    entries, not new hexes or new coordinates, so those bounds (and
//    therefore design note #33's transparent margin labels) are bit-for-bit
//    unchanged; re-verified rather than assumed.
// 35. **Accurate 1830 Base Value Corrections + Zero-Value Un-Networked
//    Cities.** Item 1 (Tab-Switching Guard): re-verified, not re-applied --
//    this item is a verbatim repeat of design note #34/item 1, and the
//    `observedWidth <= 10 || observedHeight <= 10` gate that item added is
//    still exactly in place, unchanged. Items 2-3: added
//    `HEX_START_VALUE_OVERRIDE`, a new per-hex-label $ override consulted by
//    `hexRouteValue` and the value-badge passes BEFORE their existing
//    flat-`terrainBaseValue`-by-terrain fallback -- New York $40, Boston
//    $30, Baltimore $30, Montreal (A19) $40, Cleveland (F6) $30 (item 2,
//    independently re-derived twice against `tobymao/18xx`'s
//    `g_1830/map.rb`: New York's and Montreal's real printed track has TWO
//    and one `city=revenue:40` node respectively, Boston/Baltimore/Cleveland
//    each one `city=revenue:30` node); the four `YELLOW_OO_HEXES` and the
//    eight `cityDesignation` hexes all $0 (item 3, also independently
//    re-derived: the OO hexes' real source strings print an explicit
//    `city=revenue:0` on BOTH stations, not merely an unspecified value, and
//    the eight blank city hexes were already confirmed at $0 in design note
//    #34). A $0 override skips the on-canvas badge draw entirely (this
//    item's own "fully hiding or removing" instruction) rather than
//    printing a literal "$0" plate; `hexRouteValue`'s tooltip figure still
//    correctly reports 0 for these hexes (accurate, and useful information
//    the badge alone can't convey while hidden). Every hex NOT named by
//    this item -- Lansing/Altoona/Rochester/Richmond (the four `GRAY_HEXES`
//    city markers item 2 didn't cover) and every `townDesignation` hex --
//    is completely untouched, still flat $20/$10 as before. TWO FACTUAL
//    CORRECTIONS caught here (see `HEX_START_VALUE_OVERRIDE`'s own doc
//    comment for the full sourcing): this item labeled F6 "Chicago" -- F6
//    is real, verified Cleveland; Chicago is the unrelated off-board hex F2,
//    already on its own separate era-tiered value system this change
//    doesn't touch. And this item's "8 newly injected city hubs" list
//    actually named nine hexes, including "River Falls F24" -- F24 is
//    Mansfield, a `GRAY_HEXES` Town hex (already correctly $10, unrelated to
//    design note #34's eight `cityDesignation` city hubs), left untouched
//    rather than incorrectly zeroed out. B16 is, again, Ottawa, not
//    "Barrington" (design note #34) -- restated, not silently re-applied.
//    BACKEND SCOPE NOTE: this item asked for the correction on "both
//    layers," but the backend's `hexmap::terrain_base_value` was
//    deliberately left untouched -- see that function's own doc comment in
//    `src/hexmap.rs` for the full reasoning (in short: it's live payout
//    math that would apply to every future color-tier upgrade forever, not
//    a "starting" preview figure; and `pathfinding.rs`'s own route tracer
//    already scores every untiled hex, landmarks included, at a uniform
//    $0 today, so there was no existing hex-specific "starting value" layer
//    on the backend to correct in the first place -- only this file's
//    on-canvas preview badge has ever shown one). Item 4 (Margin
//    Visibility): re-verified rather than assumed, same reasoning as design
//    note #34/item 3 -- this pass changed no `STATIC_BOARD_HEXES`
//    coordinates, only value-lookup data, so `computeBoardMarginLabels`'s
//    bounds and design note #33's transparent-label rendering are
//    unaffected.
// 36. **Station Token markers (backend: `hexmap.rs` module doc comment
//    #23).** The backend tracks each corporation's Station Tokens in
//    `PublicCompanyState.home_hex_label`/`station_token_hexes`/
//    `station_token_limit`, but never drew anything for them -- this item
//    adds that rendering. New optional `publicCompanies` prop, typed as
//    `StationTokenCompany[]` (a local, hand-kept SUBSET mirror of
//    `utils/gameState.ts`'s `PublicCompanyState` -- deliberately
//    re-declared here rather than imported, matching this file's own
//    design note #2 "client-side mirrors, not shared imports" convention
//    and `gameState.ts`'s own `QueryCapableClient` precedent, so this
//    otherwise self-contained component keeps no cross-component type
//    dependency). `STATION_HOME_HEXES` is a local mirror of
//    `hexmap::CORPORATION_HOME_HEX` (originally a 7-of-8-corporations list,
//    NNH omitted for the same "no assigned home hex" reason the backend
//    omitted it; HISTORICAL as of design note #44's house rule, which gives
//    NNH a home too -- see #44) -- needed because a company that hasn't
//    floated yet has an
//    EMPTY `station_token_hexes` (the free home token is only granted at
//    float, by `grant_home_station_token`), so the pre-float "preprinted"
//    marker has nowhere else to read its position from. Two drawing
//    passes, inserted right after the existing city-circle passes (so
//    every token marker layers on TOP of the plain white/gray/OO station
//    circle already drawn under it, never the reverse): (1) for each
//    `STATION_HOME_HEXES` entry whose matching company is missing from
//    `publicCompanies` or not yet `is_floated`, a MUTED marker (translucent
//    gray fill, dashed outline) at that preprinted home hex -- "reserved,
//    not yet active"; (2) for each floated company, a REAL marker (solid
//    `STATION_TICKER_COLORS` fill, solid light outline) at every entry in
//    its own `station_token_hexes` -- which, since `grant_home_station_token`
//    always inserts the home hex first, naturally covers the home token
//    AND any additional paid tokens `ExecuteMsg::PlaceStationToken` places
//    later, with no separate rendering path needed for those. Both passes
//    share `drawStationTokenMarker`, sized via the SAME `size * 0.22`
//    radius `drawStationCircle` already uses ("sized to match the large
//    white city circles" was explicit in the request), with the
//    corporation's own ticker acronym fit inside via the existing
//    `fitFontSize` helper. `STATION_TICKER_COLORS` is a small, deliberately
//    DUPLICATED copy of `StockMarketRenderer.tsx`'s own `TICKER_COLORS`
//    table (same values, same `company_id` keys) -- duplicated rather than
//    imported for the identical cross-component-independence reason as
//    `StationTokenCompany` above; if that file's palette is ever
//    intentionally re-tuned, this copy needs a matching manual update.
//    One board-geometry special case (a second, New York/G19 one, was added
//    later by design note #44 once NNH got a home there): ERIE's home hex
//    (E11) is a
//    `YELLOW_OO_HEXES` double-city hex, whose TWO station circles already
//    sit offset left/right of true hex center (`drawOOCityMarkers`) rather
//    than AT center -- drawing ERIE's marker at raw center would float it
//    visibly between both circles instead of sitting on either, so
//    `stationMarkerPoint` special-cases any `STATION_HOME_HEXES`/
//    `station_token_hexes` coordinate matching a `YELLOW_OO_HEXES` label
//    and offsets it onto that hex's own LEFT station circle (the same
//    `size * 0.32` x-offset `drawOOCityMarkers` itself uses) -- the other,
//    right-hand circle is left free, matching this hex's real "shared OO
//    city" identity (module doc comment #23 flags E11 as shared) even
//    though no second corporation is currently assigned there.
// 42. **Rail Map Overhaul (canvas rendering pipeline + control toolbar).**
//    A broad request covering track curves, hex clipping, barrier styling,
//    text legibility, layer order, terrain icon scale, a City Names
//    visibility toggle, and control-overlay cleanup. Two sub-items were
//    checked against this file's own already-verified data and NOT
//    implemented as literally worded AT THE TIME, per this project's
//    established "verify, don't silently trust a request's own factual
//    claims" discipline (design notes #22/#26/#29/#30 all did the same) --
//    BOTH ARE NOW HISTORICAL, superseded by design note #44's later,
//    explicitly-repeated house-rule request; see #44 for the current
//    behavior:
//    (a) the request asked for Albany (E19) to carry "the preprinted NYC
//    home station reservation token" -- but NYC's real, backend-enforced
//    home hex was G19 at the time (`hexmap::CORPORATION_HOME_HEX`,
//    `STATION_HOME_HEXES` above, both independently sourced to the real
//    board), and a fresh `tobymao/18xx g_1830/map.rb` read this pass
//    confirmed E19's own real source string is a bare `'city'` entry -- a
//    genuine, blank, valueless city, same category as Toledo/Providence/
//    etc., not a home station of any kind on the real board. Implemented at
//    the time: E19 gets `cityDesignation: true` (a real white station
//    circle) and a `NAMED_HEX_LABELS` entry ("Albany"), exactly like every
//    other blank `cityDesignation` city -- see its own
//    `HEX_START_VALUE_OVERRIDE` entry for the no-revenue-badge sourcing
//    (that sourcing is UNCHANGED by #44 -- Albany's own printed revenue
//    doesn't depend on whose home token sits there). NYC's actual home
//    token stayed at G19 at the time; #44 later moved it to E19 as an
//    explicit house rule. (b) the request separately asked to "assign NYNH
//    home token reservation to its designated slot on the yellow New York
//    hex (G19)" -- but NNH (this custom board's real ticker for the
//    corporation the request calls "NYNH", `public_company.rs`) had NO
//    assigned home hex at all at the time, anywhere on this board, by
//    deliberate backend design (`hexmap.rs` module doc comment #23, "NNH
//    has no assigned home hex... flagged, not guessed" -- independently
//    reinforced by a dedicated backend regression test at the time). G19
//    was NYC's own real home then; giving NNH a second, fabricated marker
//    on the SAME hex would have both contradicted that then-tested backend
//    contract and visually collided with NYC's genuine token. Not
//    implemented at the time; #44 later gave NNH G19 as its own home once
//    NYC vacated it for Albany, resolving the collision this note
//    originally flagged.
//    Every other item was implemented as requested: `withHexClip`/
//    `bezierTrackSegment`/`edgeInwardNormal` (Hex Boundary Clipping Mask +
//    perpendicular-entry `ctx.bezierCurveTo` track splines, replacing this
//    file's previous `quadraticCurveTo` track curves throughout);
//    `drawImpassableBorderEdge` recolored to `#E53E3E` and clamped to a
//    literal 3px-4px width; `fillTextWithHalo`/`drawLabelWithBackground`'s
//    new `strokeHalo` option (dark `strokeText` outline behind nameplates,
//    board margin labels, off-board zone names, and value-badge figures);
//    `drawStationTokenMarker`'s muted/reserved badge now pairs a lighter
//    soft-gray fill with a DARK acronym overlay (was light-on-gray, low
//    contrast); `drawMountainIcon`/`drawRiverIcon` both scaled to `size *
//    0.7`; the new `showCityNames` toggle (gates every name-label pass
//    only -- station tokens, value badges, and every track spline are
//    drawn by separate, unconditional passes); and the old standalone
//    "Toggle Detailed View" button is removed outright, with the "+"/"-"/
//    "Fit to Screen" buttons and the new City Names toggle consolidated
//    into one floating top-right `MAP_CONTROLS_PANEL_STYLE` card, inset
//    further from the canvas corner than the old separate buttons were.
//    The already-existing layer order (fill -> terrain icons -> track
//    splines -> station badges -> name labels, see design note #6c's
//    "Track-Under-Text Layer Masking" and `drawHexNameLabel`'s own doc
//    comment) already matched this item's requested hierarchy and needed
//    no restructuring. `drawValueBadge`'s adaptive corner placement (design
//    notes #26/#39, dodges live track edges) was deliberately left as-is
//    rather than forced into a fixed lower-third slot -- that adaptive
//    system exists specifically to fix a real collision bug a fixed slot
//    would reintroduce; the terrain build-cost label (a different,
//    unrelated label) already uses a fixed lower-third slot on its own.
// 43. **Corporate Station Badges follow-up: backend audit + ERIE margin
//    placement.** A follow-up request repeated design note #42's Albany/
//    NYC-home/NYNH-home/ERIE-hex claims essentially verbatim, plus asked
//    for a backend audit of `src/hexmap.rs`. Re-verified from scratch
//    against the CURRENT backend at the time (nothing had changed since
//    #42): NYC's real home was still `G19` and NNH still had no home hex at
//    all (`hexmap::CORPORATION_HOME_HEX`, unchanged at the time) -- so,
//    again, no NYC token was added to Albany and no NYNH/NNH token was
//    added to G19 at the time, for the exact reasons design note #42
//    already gives. HISTORICAL as of design note #44: a later, third,
//    explicitly-specific repeat of this same request was implemented as a
//    deliberate house rule -- see #44. ERIE's real home hex is still `E11`
//    (Dunkirk & Buffalo) on BOTH sides of the stack, not "D6" -- `D6` is a
//    real, different, unrelated hex on this board's own axial system (a
//    River hex, see `STATIC_BOARD_HEXES`), never associated with ERIE
//    anywhere in `hexmap.rs`; this part is UNCHANGED by #44 (ERIE's home
//    was not part of that later request). Albany's requested "$20" revenue
//    badge was checked again too: still incorrect -- its real source entry
//    is a bare `city`, printing no revenue figure at all; also UNCHANGED by
//    #44, since that fact doesn't depend on whose home token sits on Albany.
//
//    The backend audit DID surface one genuine, previously-missed gap:
//    `hexmap.rs`'s `CITY_DESIGNATED_HEXES` (the on-chain City Reservation
//    list gating which hexes may legally receive a `MajorCityHub` tile)
//    had no Albany/E19 entry, even though this file's own `cityDesignation`
//    flag on E19 (added by design note #42) already rendered it as one
//    on-screen -- a real frontend/backend mismatch: a Protocol attempting
//    to actually upgrade Albany on-chain would have been illegally
//    rejected despite the frontend showing a legal-looking city marker.
//    Fixed backend-side (`hexmap.rs`'s own matching doc comment on that
//    same const), not here -- no frontend change was needed for this half
//    of the item, since `HexGridRenderer.tsx` doesn't independently gate
//    tile legality (it queries `QueryMsg::GetLegalTilePlacements`, which
//    now correctly includes Albany once the backend fix lands on-chain).
//
//    One item WAS a genuine frontend refinement, independent of the wrong
//    "D6" coordinate: ERIE's RESERVED (not-yet-floated) badge previously
//    rendered anchored onto E11's own LEFT station circle
//    (`stationMarkerPoint`'s existing OO-hex offset, design note #36) --
//    which could misleadingly read as "ERIE's home is specifically the
//    left slot," when real 1830 actually lets ERIE's President choose
//    EITHER of E11's two slots on its first Operating Round turn after
//    floating (`hexmap.rs` module doc comment #23). The muted/reserved
//    pass now special-cases any `YELLOW_OO_HEXES` home hex to draw in
//    neutral margin space below both circles instead (`center.y + hexSize *
//    0.46`, comfortably inside the hex's own apothem and clear of both
//    station circles) -- reading as "reserved, slot not yet chosen" rather
//    than committing to one. The REAL, floated token (once ERIE actually
//    floats) is UNCHANGED -- still `stationMarkerPoint`'s left-circle
//    convention -- since the chain itself only ever records E11's one
//    `(q, r)`, never which corner was picked (same known simplification
//    design note #36 already flagged), so there's no real per-corner data
//    for the floated marker to reflect either way.
// 44. **House-Rule Home Reassignment: NYC/Albany, NYNH/New York (mirrors
//    `hexmap.rs` module doc comment #25).** Design notes #36/#42/#43 all
//    independently verified, and twice declined, this exact NYC-home-moves-
//    to-Albany / NNH-gets-G19 request as factually inconsistent with real
//    1830 (NYC's real home is G19; NNH has no real 1830 analogue with a
//    separate home at all in this custom board's design). On a third,
//    explicit, more specific repeat -- now paired with an equally explicit
//    backend request to change `hexmap::CORPORATION_HOME_HEX` itself -- this
//    is implemented as the deliberate house rule it clearly now is for this
//    custom board, matching the backend change: see `hexmap.rs` module doc
//    comment #25 for the full mechanical-safety verification (home tokens
//    are decoupled from tile-laying, so this is purely cosmetic/
//    informational on both sides of the stack). `STATION_HOME_HEXES` above
//    now gives NYC (company_id 2) Albany E19 and NNH (company_id 7, "NYNH")
//    New York G19 -- the hex NYC vacated -- a clean swap, no collision,
//    mirroring the backend const entry-for-entry.
//
//    Three rendering consequences, all implemented this pass:
//    (a) Albany (E19) already had `cityDesignation: true` and a "Albany"
//    `NAMED_HEX_LABELS` nameplate from design note #42 -- the preprinted
//    "NYC" reserved/home badge now appears there "for free" once
//    `STATION_HOME_HEXES` points NYC at E19, since the muted-badge-drawing
//    pass already iterates that list generically. Albany's revenue badge is
//    still deliberately NOT added -- its real source entry prints no
//    revenue figure at all (`HEX_START_VALUE_OVERRIDE["E19"] = 0`, see
//    design note #42's own sourcing), and that fact is unaffected by whose
//    home token happens to sit there now; a "$20 base revenue badge" would
//    still be inventing a figure with no source.
//    (b) NNH's reserved/home badge, now real, needed a placement fix New
//    York's own geometry requires: G19 is a `LANDMARK_HEXES` hex with TWO
//    disconnected stub stations (`LANDMARK_TRACKS["New York"]`, design note
//    #6b), not raw hex center and not a `YELLOW_OO_HEXES` hex either, so
//    `stationMarkerPoint`'s existing OO-hex special case didn't cover it --
//    without a fix, NNH's badge would've drawn at New York's literal center,
//    floating in the gap between both real stub stations (exactly the "do
//    not render floating in the middle of the hex" outcome explicitly
//    flagged against). Added a second special case to `stationMarkerPoint`
//    (see its own updated doc comment) anchoring any G19 marker onto the
//    NORTHEAST of the two stub stations specifically (edge 1 under this
//    file's own `edgeAngleRad` convention, design note #1) via the exact
//    same stub-station formula `drawLandmarkTrack` itself already uses for
//    that segment, rather than a second, independently-drifting copy of
//    that geometry.
//    (c) ERIE's existing margin-badge placement (design note #43) is
//    untouched by this pass -- ERIE's own home hex (E11) was not part of
//    this request.
//
//    Acronym badges on every home/reserved token -- muted soft-gray fill,
//    bold dark acronym text, for every `STATION_HOME_HEXES` entry not yet
//    floated -- were already fully implemented by design note #36's
//    `drawStationTokenMarker` and design note #42's contrast fix; this pass
//    re-verified that behavior against the current, wider 8-of-8
//    `STATION_HOME_HEXES` list and found no further change needed.
// 45. **Corporate Acronym Overlay guarantee (CORRECTS design note #44's own
//    "found no further change needed" claim above).** A follow-up request
//    reported reserved/unfloated home badges rendering as plain gray/dashed
//    circles with no acronym text at all -- design note #44 had just
//    re-verified this exact rendering path and concluded it needed no
//    change; that conclusion was WRONG, and this note corrects it rather
//    than silently rewriting #44's text. Root cause, found by re-reading the
//    muted-pass call site rather than just `drawStationTokenMarker` itself:
//    the reserved pass has always called `drawStationTokenMarker` with
//    `company?.ticker ?? ""` -- and `publicCompanies` is an OPTIONAL prop
//    (design note #36 already documented "before the host app's first
//    `GetGameState` query resolves" as a real, expected state) that's often
//    empty or not yet loaded on first paint. In that window,
//    `company` is `undefined`, the ticker argument is `""`, and
//    `drawStationTokenMarker`'s own `if (!ticker) return;` guard -- present
//    since design note #36 -- silently skips the ENTIRE text-drawing block,
//    leaving a bare circle with no acronym at all. Design note #44's
//    re-verification checked the drawing function's styling logic (colors,
//    font, contrast) and found it correct, but never actually exercised the
//    "`publicCompanies` not loaded yet" path that #36 itself had already
//    flagged as a real possibility -- that's the gap this note closes.
//
//    Fix: added `STATION_TICKER_LABELS`/`stationTickerLabel` -- a small,
//    static, duplicated copy of `public_company.rs`'s real on-chain tickers
//    (same "copy, don't import" convention as `STATION_TICKER_COLORS`),
//    keyed by `company_id`, so the correct acronym is available with NO
//    dependency on `publicCompanies` ever loading. The muted call site now
//    passes `company?.ticker || stationTickerLabel(home.companyId)` --
//    live data wins if present, but the fallback is never an empty string,
//    so every one of the 8 `STATION_HOME_HEXES` entries draws its acronym
//    unconditionally on every paint. Company 7's static label is `NNH` (its
//    real on-chain ticker, `public_company.rs`'s `CORE_PUBLIC_COMPANIES`),
//    not the request's own "NYNH" wording, so the placeholder text matches
//    exactly what `company.ticker` will show once that corporation actually
//    floats -- avoiding a visible acronym flip at that moment, consistent
//    with design note #36's own established "NNH is this board's real
//    ticker, NYNH is the request's colloquial name for it" distinction.
//
//    Also added, as explicitly requested and independent of the bug fix
//    above: an opaque, solid `#000000` `strokeText` halo (`lineWidth = 2`,
//    `lineJoin = "round"`) painted immediately before every acronym's
//    `fillText` call, in both the muted and floated branches -- deliberately
//    NOT routed through this file's existing `fillTextWithHalo` helper
//    (design note #42), which uses a larger, semi-transparent 3px halo
//    tuned for bigger labels drawn over busy track/terrain fills; this
//    badge is small (`radius = size * 0.22`) and already sits on a flat
//    color, so a smaller fully-opaque halo reads crisply on a short 2-4
//    letter acronym without swallowing its glyph strokes. Font sizing
//    deliberately stays on the existing adaptive `fitFontSize` helper
//    rather than switching to a literal fixed `'bold 11px sans-serif'` as
//    the request's own wording suggested -- `hexSize` (and therefore
//    `radius`) is dynamic (pan/zoom, `ResizeObserver`-driven auto-fit, see
//    design note #27), so a fixed px size would either overflow the badge
//    at low zoom or read illegibly small at high zoom; `fitFontSize` is
//    already this file's own established solution to exactly that problem
//    for every other in-canvas label, and was kept rather than replaced by
//    a fixed value it would fight against.
// 46. **Crisp Token Typography (CORRECTS design note #45's own halo
//    weight).** A follow-up report: acronym text inside station badges was
//    an illegible blob. Root cause was exactly what it looked like -- #45's
//    own `lineWidth = 2` `strokeText` halo, at this badge's small `radius =
//    size * 0.22` and an as-small-as-9px (previously as-small-as-6px)
//    glyph, is thick enough to fill in tight letterform counters (the "B"s
//    in B&O/B&M, the "O" in B&O/CPR, the "&" itself) -- a real regression
//    #45 introduced while fixing a different, real bug (see #45's own text
//    for that one). Thinned to the requested `lineWidth = 0.5` (kept, not
//    removed outright, since a thin edge still measurably helps at extreme
//    zoom-out) and recolored to the OPPOSITE of each badge's own computed
//    text color (`bestContrastTextColor`, new this pass) rather than a
//    fixed `#000000` -- so it reads as a thin contrast-boosting edge in
//    every case, including the badges whose best text color is now black
//    (see below), where a black halo behind black text would have done
//    nothing at all.
//
//    Badge fill/text colors overhauled together, both requested and to keep
//    the halo fix internally consistent: (a) reserved/unfloated badges now
//    fill solid, opaque `#1E293B` (one of the two literal values requested;
//    picked over `#334155` for its clearly higher contrast headroom --
//    ~14.6:1 vs. white, vs. `#334155`'s ~10.3:1, both comfortably past the
//    7:1 AAA line but `#1E293B` leaves more margin) with pure white
//    (`#FFFFFF`) acronym text, replacing the previous translucent light-gray
//    fill with dark text -- a much larger, unambiguous jump in contrast, not
//    a marginal tweak. (b) Floated badges keep their existing corporate
//    `STATION_TICKER_COLORS` fill (unchanged, out of scope -- see below) but
//    now pick whichever of pure white/pure black actually contrasts better
//    against that specific color, computed via `bestContrastTextColor`'s
//    real WCAG relative-luminance formula, rather than the previous fixed
//    light-cream (`#f4ecd8`) fill used for every corporation alike.
//
//    HONEST LIMITATION, flagged rather than silently claimed away: the
//    request asked for "high contrast standards (WCAG AAA)" on floated
//    badges specifically. Checked the actual numbers rather than asserting
//    it: `STATION_TICKER_COLORS`'s eight established brand colors (design
//    note #36, deliberately duplicated from `StockMarketRenderer.tsx`'s own
//    `TICKER_COLORS` -- re-tuning that shared palette is out of scope here)
//    only reach the literal 7:1 AAA threshold, against EITHER pure white or
//    pure black, for three of the eight: B&O (~7.3:1, black), C&O (~7.4:1,
//    black), B&M (~9.3:1, white). The other five's own BEST available
//    choice still falls short of 7:1 -- PRR ~5.4:1 (white), CPR ~5.9:1
//    (white), ERIE ~6.4:1 (black), NNH ~6.0:1 (white), and NYC the tightest
//    at ~4.9:1 (black) -- all comfortably clear of the lower 4.5:1 AA
//    threshold for normal text, but genuinely short of AAA. This is a
//    property of the brand palette itself, not a bug in the color-picking
//    logic (`bestContrastTextColor` always returns whichever option is
//    measurably better); reaching true AAA for all eight would require
//    darkening/lightening the corporate colors themselves, which would also
//    de-sync them from `StockMarketRenderer.tsx`'s own copy -- flagged for
//    a future pass rather than done silently here.
//
//    Font family: `fitFontSize`'s generic `sans-serif` became the requested
//    explicit `system-ui, -apple-system, sans-serif` stack (new
//    `FONT_FAMILY_STACK` constant) -- applied to `fitFontSize` itself, so
//    all eight of its call sites across this file benefit at once, since a
//    font-family swap (unlike a size floor) can't overflow any caller's own
//    `maxWidthPx`: `fitFontSize`'s own shrink-to-fit loop re-measures
//    against whatever font actually resolves and backs off further if
//    needed, same as it always has. Minimum font size floor: raised from 6
//    to 9 for the station-badge acronym call site specifically (this
//    function's own `minFontSizePx` argument), NOT inside `fitFontSize`
//    itself -- seven other call sites in this file share that helper with
//    their own independently-tuned minimums (5px for off-board value
//    badges, 6-7px for name/cost labels), and a shared global 9px floor
//    would silently override every one of those and risk overflowing their
//    own, much tighter `maxWidthPx` budgets. The floor this request asked
//    for is real, just applied at the one call site it was actually about.
// 47. **Canonical Tile Upgrade Restrictions: "B" / "NY" / "OO" badges,
//    Dynamic City Nameplate Suppression, and off-board label offsets**
//    (mirrors `hexmap.rs` module doc comment #26 for the backend half of
//    this request). Four independent pieces:
//
//    (a) NEW "B"/"NY"/"OO" restriction badges (`drawRestrictionBadge`, new
//    this pass) at Boston, New York, and the four `YELLOW_OO_HEXES` --
//    purely informational, drawn at each hex's own upper-left geometric
//    corner (see that function's own doc comment for why NOT the same
//    mid-radius zone `drawValueBadge` uses), gated on `!hexHasLaidTile`
//    (part (c) below) per the request's own "before tiles are laid"
//    framing. No client-side legality re-check was added anywhere --
//    `TileSelectionPopup.tsx`'s own design note #4 already established
//    "no client-side re-validation of legality" as this project's
//    standing policy, and the backend's new `hexmap::legal_tile_placements`
//    restriction (module doc comment #26) already flows through
//    automatically with zero frontend catalog to keep in sync.
//
//    (b) A genuine, previously-uncaught gap fixed as a load-bearing
//    prerequisite for (c): `describeHex` (the hover-tooltip name source)
//    only ever special-cased `LANDMARK_HEXES` and `OFFBOARD_LABELS` --
//    every `NAMED_HEX_LABELS` city (Washington, Toledo, Providence, Albany,
//    Cleveland, Altoona, the four OO names, the three double-town names --
//    everything that isn't a landmark or off-board zone) fell through to
//    the bare coordinate label (e.g. "J14") with no city name at all. Not
//    a problem on its own before this pass, but about to become one: once
//    (c) suppresses a tiled hex's ON-CANVAS nameplate, the tooltip becomes
//    the ONLY remaining place that name is shown -- so `describeHex` was
//    extended to also consult `NAMED_HEX_LABELS` before falling back to
//    the bare label, closing the gap for every affected hex at once, not
//    just the ones this request happens to mention.
//
//    (c) Dynamic City Nameplate Suppression (`hexHasLaidTile`, new this
//    pass): physical-board parity -- laying a tile covers the hex's
//    preprinted name in real 1830, so this file's four PREPRINTED-name
//    drawing passes (landmark labels, the single-name `NAMED_HEX_LABELS`
//    pass, the OO stacked-name pass, the double-town stacked-name pass)
//    each gained one more skip condition alongside their existing
//    `showCityNames` toggle check. Deliberately NOT applied to
//    `drawOffboardNameplate` (an off-board hex can never receive a laid
//    tile at all, `hexmap.rs` module doc comment #14, so the check would
//    always be false there) or to the value-badge pass (this request's own
//    "text plate" wording was about names, not the $ badges, which keep
//    showing regardless of tile state as they always have). The name
//    remains 100% available on hover per (b) above and per the tooltip's
//    own pre-existing "no tile-laid gate" behavior (unchanged by this
//    pass).
//
//    (d) Nameplate text and off-board label offsets: Washington's
//    `NAMED_HEX_LABELS` entry (`J14`) is now `"Washington, D.C."`, was the
//    bare `"Washington"` -- `fitFontSize`'s existing shrink-to-fit already
//    absorbs the longer string at any zoom, no separate width tuning
//    needed. `drawOffboardNameplate` now splits any multi-word off-board
//    name ("Canadian West", "Deep South", "Maritime Provinces") into two
//    stacked lines at the first space, same "A & B" stacking shape the
//    OO/double-town name passes already use -- reported specifically for
//    "Maritime Provinces" (this board's single longest off-board name, on
//    a single, non-merged hex, previously squeezed onto one line), applied
//    uniformly to every multi-word zone name rather than special-cased to
//    just that one. Single-word names ("Chicago", "Gulf") are unaffected.
//    The broader "inspect for track/border collisions" ask turned up no
//    other concrete, reproducible collision beyond the Maritime Provinces
//    case above -- design note #22's existing offset padding
//    (`center.y -/+ hexSize * 0.42/0.44`) and design note #39's adaptive
//    `BADGE_CORNERS` system for landmark value badges were both
//    re-verified against their own already-documented reasoning and left
//    unchanged rather than adjusted without a specific, identified
//    collision to fix.
//
//    UPDATE (design note #49): part (a)'s badge styling (dark navy pill,
//    white text) and persistence (`!hexHasLaidTile` gate) are BOTH reversed
//    by that later pass -- see #49 for the current, full design. This note
//    is left as-is for history rather than rewritten.
// 48. **Solid Corporate Brand Color Borders (reserved/unfloated station
//    tokens).** `drawStationTokenMarker`'s muted (reserved, not-yet-
//    floated) badge outline was a dashed, near-white `#e4e7ec` ring, sized
//    to `hexSize` (`Math.max(2, size * 0.05)`) -- reported as visual noise,
//    and carrying no information a player could act on. Replaced with a
//    solid ring in the SAME corporate brand color (`STATION_TICKER_COLORS`)
//    that badge's own company will fill with once floated -- a reserved
//    badge now previews its eventual color at a glance, before the acronym
//    text is even read, rather than a generic gray outline every
//    corporation shared. Fixed at `1.75px` (within the requested
//    1.5px-2px range) rather than scaled with `hexSize` like most of this
//    file's other strokes -- deliberate: a thin, CONSTANT ring reads as
//    clean and intentional at every zoom level, where a size-scaled one
//    would balloon into a heavy band at high zoom, working against the
//    "eliminate noise" goal this pass was actually asked for. The badge
//    fill (`#1E293B`, design note #46) and the acronym's own
//    `bestContrastTextColor`-computed fill/halo (also #46) are both
//    unchanged -- the fill sits well inside this ring with no visual
//    overlap, since the ring is thin and drawn AT the circle's own radius
//    (`ctx.arc`'s stroke straddles that path, not inset into the interior
//    the text occupies). Floated badges' own outline (`#f4ecd8`, solid,
//    `hexSize`-scaled) is unchanged -- this request was scoped to the
//    reserved/unfloated case specifically, not every token.
// 49. **"B"/"NY"/"OO" Tile Manifest Completion, Persistent Plain-Text
//    Restriction Labels, and OO Diagonal Geometry Refactor** (mirrors
//    `hexmap.rs` module doc comment #27 for the backend half of this
//    request). Four independent pieces:
//
//    (a) Tile Manifest Completion -- a genuine, previously-uncaught
//    cross-file gap, fixed as a load-bearing prerequisite for the rest of
//    this pass: `TerrainType`/`TILE_CATALOG` here never gained entries for
//    `BostonHub`/`NewYorkHub` (added to the BACKEND catalog by module doc
//    comment #26, tiles 16/17) at all. Concretely, `TILE_CATALOG_BY_ID.get(16)`
//    always returned `undefined`, so the main board renderer's own
//    fallback paths kicked in for a laid Boston/New York Green tile: its
//    hex OUTLINE rendered in the "unknown tile" fallback red
//    (`#c0392b`) instead of the real Green/Brown tier stroke, and its
//    `TileSelectionPopup.tsx` picker thumbnail (`TilePreviewThumbnail`)
//    rendered as a bare "#16?" placeholder instead of real tile art. Closed
//    by mirroring `hexmap::TILE_CATALOG` tiles 16-24 here exactly (see
//    `TerrainType`'s own updated doc comment) -- `BostonHub` renders like
//    `MajorCityHub` (one station), `NewYorkHub` like the OLD `DoubleCityHub`
//    layout (two stations, side by side -- a legally separate reservation
//    from OO per module doc comment #26/#27, so it does NOT adopt part (c)
//    below's new diagonal geometry).
//
//    (b) Persistent, Plain Restriction Labels -- TWO explicit reversals of
//    design note #47's own decisions on `drawRestrictionBadge`, both left
//    in place there for history (see #47's own "UPDATE" pointer) rather
//    than rewritten: (i) styling -- plain, crisp `#000000` text, NO
//    background pill/box/circle of any kind (was a `#0f172a` navy box with
//    white text); the corner anchor's radius fraction is pulled in from
//    `apothem * 0.85` to `0.7` so the now-unboxed glyphs stay clearly inset
//    within the hex border at every zoom level, not just at the box's old
//    padded edge. (ii) persistence -- both call sites' `!hexHasLaidTile`
//    gate is removed outright, so "B"/"NY"/"OO" now stay visible across
//    every tile phase (un-tiled preprinted hex, Yellow, Green, Brown) --
//    the opposite of #47's own explicit "before tiles are laid" framing.
//    Per the request's own wording, this is purely informational styling;
//    it changes nothing about which tile artwork is actually LEGAL where --
//    that's still entirely `hexmap::legal_tile_placements`' job (module doc
//    comment #26/#27), unaffected by any of this file's rendering choices.
//
//    Also folded in here: Baltimore now gets a "B" badge alongside Boston
//    (real 1830 prints "B" on both hexes, not just Boston -- see backend
//    module doc comment #27's own Verification Status paragraph for the
//    sourcing caveat this carries).
//
//    (c) OO Diagonal Geometry Refactor -- `drawOOCityMarkers`'s two station
//    circles move from left/right (design note #12) to a top-right/
//    bottom-left DIAGONAL (`ooCityMarkerOffset`, a new shared helper so the
//    pre-laid marker and a laid tile's own `drawTrackPath` `DoubleCityHub`
//    branch can never drift out of sync with each other), per the
//    request's own explicit wording. `stationMarkerPoint`'s matching
//    `YELLOW_OO_HEXES` anchor moves with it (previously the LEFT circle,
//    now the bottom-left one, via the same shared offset rather than a
//    second hand-computed literal).
//
//    Everything else in this hex was repositioned to stay clear of the new
//    diagonal circles: the stacked dual-city nameplate (design note #41)
//    moves from the upper-third band every other name label uses to TRUE
//    HEX CENTER -- the genuinely open space between a top-right and a
//    bottom-left circle is the middle of the hex, not the top. The two OO
//    hexes that are ALSO real River hexes (D10/E5) get their water icon and
//    $80 terrain-cost label moved into the bottom-right quadrant (the one
//    remaining open corner), with the icon scaled to `hexSize * 0.6` (~40%
//    smaller than the standard `hexSize` scale) so it comfortably fits
//    alongside the label without overlapping the diagonal circles, the
//    track splines converging on them, or the re-centered nameplate. Every
//    other Mountain/River hex on the board (not one of the four OO hexes)
//    is completely unaffected -- still centered, still full-size.
// 50. **Standardized City Nameplate Typography & Expanded OO Diagonal
//    Offset.** Three pieces:
//
//    (a) Strip Pills, Boxes & Halos: `drawHexNameLabel` (item 7, "Muted
//    Base Text with Hover Glow") REPLACED entirely -- no more
//    `drawLabelWithBackground` translucent plate, no more `strokeHalo`
//    dark-stroke-outline pass, no more hover drop shadow. Every city/town/
//    landmark nameplate this function draws (landmark names, gray/
//    `NAMED_HEX_LABELS` single names, and both stacked-pair passes below)
//    is now a single plain `ctx.fillText` in solid `#000000`, painted
//    directly on the hex's own fill -- nothing drawn behind or around it.
//    Item 7 itself is left in place at its own comment, unedited, for
//    history, same as this file's established convention for a superseded
//    decision (see e.g. #47's own "UPDATE" pointer to #49).
//
//    (b) Standardized Font Sizing: `NAMEPLATE_FONT_SIZE_PX`/
//    `NAMEPLATE_FONT_MIN_PX` (10/8, `drawHexNameLabel`'s own doc comment
//    has the full reasoning) replace the OLD base-10/min-6 (rest) and
//    base-13/min-7 (hover) `fitFontSize` calls -- a genuinely narrow 2px
//    band that only actually engages for the handful of long single-line
//    outlier names ("Washington, D.C.", "Atlantic City"); every other name
//    on the board, including both halves of every OO/double-town stacked
//    pair, now renders at the exact same 10px. Hover no longer changes
//    size at all (the OLD 10->13 swing was the single biggest source of
//    "wild fluctuation" here) -- weight (normal/bold) is the only
//    remaining hover cue, which doesn't reintroduce a size fluctuation.
//    TRADEOFF, stated plainly rather than left implicit: a genuinely
//    zero-tolerance FIXED size (no shrink band at all) was considered and
//    rejected -- it would make "Washington, D.C." and "Atlantic City"
//    visibly overflow their own hex's flat width at default zoom, which
//    reads as a worse defect than a 2px band covering two outlier names
//    out of this board's ~32 real city/town names.
//
//    (c) Expanded OO Diagonal Offset: `ooCityMarkerOffset`'s magnitude
//    widened from `0.3` (design note #49) to `0.43`, within the requested
//    `~0.42-0.45` range -- see that function's own doc comment for the
//    "still safely inside the hex" distance check. The OO stacked-pair
//    nameplate's own `lineOffset` (the vertical gap between its two lines,
//    dead-center per #49) widened `0.19` -> `0.24` to match, for more
//    generous margin clearance now that the circles sit further out.
//
//    NOTE on the OO/double-town split itself (UNCHANGED this pass, still
//    `name.split(" & ")` -> two lines, "A" / "B", the ampersand dropped
//    entirely): the request's own two worked examples disagree with each
//    other on this point -- one shows "Philadelphia" / "Trenton" (no "&"
//    on either line, matching this file's existing #49 behavior exactly),
//    the other shows "Detroit &" / "Windsor" (the ampersand KEPT, attached
//    to line 1). Rather than silently picking one, this pass keeps the
//    EXISTING ampersand-dropped convention -- it matches the first example
//    verbatim, it's what real 1830-style boards print (two bare city names
//    stacked, no punctuation), and it's what #49 already built and this
//    request's own task title ("match standard 18xx board aesthetics")
//    points toward -- but this is flagged here explicitly as a judgment
//    call on an inconsistent spec, not a silent assumption.
//
//    UPDATE (design note #51): point (a) above ("no more
//    `drawLabelWithBackground` ... nothing drawn behind or around it") is
//    PARTIALLY reversed -- `drawHexNameLabel` once again draws a tight
//    background box behind the text, for the track-occlusion reason #51
//    explains. This is NOT a revival of the pre-#50 dark floating pill:
//    the new box is a near-rectangular (corner radius 1px), zero-stroke,
//    zero-shadow, 2.5px-padding shape filled with a color matched to the
//    hex's own surface, sized just large enough to cover the letterforms.
//    Points (b) and (c) above stand as originally written, except where
//    #51's own text below narrows or extends them further.

// 51. **18xx-Style Text Background Shield Box, Compact Typography &
//    Expanded OO Offset.** Three pieces, closing out the remaining rough
//    edges from #50 plus one real bug found in `App.tsx` (not this file --
//    see that file's own design note #15 for the nameplate-suppression fix
//    itself; this note covers only what changed in this file):
//
//    (a) Tight Text Background Shield Boxes: #50 removed every pixel drawn
//    behind a city nameplate on the theory that solid black text directly
//    on the hex's own fill would read cleanly on its own. In practice,
//    track splines routed directly beneath a nameplate cut through its
//    letterforms, especially on busy tiled cities and OO yellow hexes where
//    two station circles' connecting curves converge near hex center. Fix:
//    `drawHexNameLabel` once again calls `drawLabelWithBackground`, but
//    with a new, much tighter footprint than the pre-#50 pill ever had --
//    `paddingX`/`paddingY` of 2.5px (vs. the old default's much larger
//    pill padding), a new `cornerRadiusPx: 1` override (see (a.1) below),
//    and `strokeHalo: false` explicitly, so there is no border stroke and
//    no drop shadow, only a flat fill. The box exists purely to occlude
//    track geometry behind the letters, not to draw attention to itself.
//
//    (a.1) `drawLabelWithBackground` itself gained one new optional
//    parameter to make this possible without duplicating its box-drawing
//    logic: `cornerRadiusPx?: number`, defaulting to its prior
//    `Math.min(6, boxHeight/2, boxWidth/2)` behavior when omitted. Every
//    existing caller (the terrain-cost label, the off-board nameplate)
//    omits it and is therefore byte-for-byte unaffected; only the new
//    nameplate shield box passes `1`, for a box that reads as essentially
//    rectangular rather than pill-shaped.
//
//    (a.2) Fill color: rather than precisely sampling each hex's actual
//    computed fill at every call site (fragile, and this function has no
//    access to the terrain/color context that far down the call chain),
//    two named constants cover the two cases the request itself calls out
//    ("match the hex background fill, OR soft pale yellow ... on yellow OO
//    hexes"): `NAMEPLATE_BOX_FILL_YELLOW` (`#FEF08A`, the softer of the
//    request's two suggested yellows) for every hex that is actually
//    printed yellow -- the three landmark hexes and every `YELLOW_OO_HEXES`
//    entry -- and `NAMEPLATE_BOX_FILL_DEFAULT` (`#f4ecd8`, chosen close to
//    `TERRAIN_FILL.Plain`/`MajorCityHub`) for everything else: the gray/
//    `NAMED_HEX_LABELS` single-name pass and the double-town stacked pass,
//    neither of which is ever printed yellow. `drawHexNameLabel` takes this
//    as a `boxFill` parameter defaulting to the DEFAULT bucket, so the two
//    call sites that need YELLOW (landmarks, OO stacked pair) pass it
//    explicitly and the two that don't (gray single names, double-town
//    stacked pair) simply omit the argument.
//
//    (b) Tight Stacked Line Height & Always-Bold Weight: a new
//    `NAMEPLATE_LINE_HEIGHT_PX = NAMEPLATE_FONT_SIZE_PX * 1.05` constant
//    (matching the request's literal `lineHeight = 1.05 * fontSize`
//    formula) replaces the OLD `hexSize`-relative stacked-line offsets
//    (`hexSize * 0.24` for OO pairs, `hexSize * 0.19` for double-town
//    pairs, both from #49/#50) with a single `NAMEPLATE_LINE_HEIGHT_PX / 2`
//    half-offset used by both passes. This is a deliberate switch from
//    zoom-relative to font-size-relative spacing: now that #50 fixed the
//    nameplate font at a near-constant 10px regardless of hex size or
//    hover, tying line spacing to that same fixed font size (rather than
//    to the hex's own radius, which changes with zoom/pan) keeps the two
//    stacked lines a constant, tight distance apart on screen at every
//    zoom level, instead of drifting wider apart as the board is zoomed
//    in. `drawHexNameLabel` also now hard-codes `"bold"` as its font
//    weight unconditionally (previously bold only applied on hover per
//    #50 point (b)'s "weight is the only remaining hover cue" line) --
//    the request's explicit ask for a bold, high-contrast sans-serif
//    nameplate applies at all times, not just on hover; hover is left
//    with no remaining visual distinction on nameplate text specifically
//    (other hover cues elsewhere in this file, e.g. hex outline highlight,
//    are untouched).
//
//    (c) Expanded OO Diagonal Offset: `ooCityMarkerOffset`'s magnitude
//    widened again, `0.43` (design note #50) -> `0.49`, within the
//    requested `~0.48-0.50` range -- see that function's own doc comment
//    for the updated safe-distance math (a circle at this offset reaches
//    about `0.66 * size` from hex center at its farthest point, still
//    inside the `1.0 * size` distance to the hex's own corners). Pushing
//    the circles further into their respective corners opens up more
//    dead-center clear space for the now-boxed nameplate to sit in without
//    visually crowding either circle, which is the point of pairing this
//    change with (a) and (b) above rather than doing it in isolation.
//
//    UPDATE (design note #52): every `TILE_CATALOG` entry this note
//    references (`0b11_1111`, "all six edges") was a fabricated
//    placeholder, not real 1830 data -- see #52's own text for the
//    correction and why it's the actual root cause #51's shield box was
//    papering over.

// 52. **Real Tile Data Correction: `TILE_CATALOG` Bitmasks & Two-City
//    Rendering.** Root-caused the underlying clutter this file's nameplate
//    passes (#47/#49/#50/#51) had been fighting for four passes running:
//    every landmark/OO/NY hub tile in `TILE_CATALOG` -- tiles 15-24 -- had
//    `connections: 0b11_1111`, meaning `drawTrackPath` drew a spoke from
//    ALL SIX hex edges into a shared center on every single one of these
//    tiles, regardless of color tier or which of the five OO variants. Real
//    1830 tiles never do this; verified against `tobymao/18xx`'s
//    `lib/engine/config/tile.rb` (fetched twice independently, byte-
//    identical both times) that every one of these tiles has 2-4 live
//    edges, not 6:
//
//    - Green "B" (real tile #53, NOT #55 as design note #27 had it --
//      #55 turned out to be an unrelated double-town tile with no "B"
//      label at all): edges 0, 2, 4.
//    - Green "NY" (real tile #54, NOT #57 -- #57 is an unrelated generic
//      unlabeled green city tile): edges 0, 1, 2, 3; city A owns 0-1, city
//      B owns 2-3.
//    - Green "OO" (real tile #59, already correctly cited): edges 0, 2 --
//      one per city, each a dead-end stub, not a through-route.
//    - Brown "B" (#61): edges 0, 2, 3, 4. Brown "NY" (#62): edges 0, 1, 2,
//      3, same city split as Green. Brown "OO" variants (#64-#68): five
//      genuinely different 4-edge patterns, each pairing its two cities'
//      edges differently -- the whole point of offering five choices.
//
//    `hexmap.rs` module doc comment #28 (backend) covers the Rust side of
//    this same correction, including a Yellow-tier restriction fix this
//    finding also required. This file's `TILE_CATALOG` mirror is updated
//    to the identical corrected bitmasks.
//
//    NEW: `TileCatalogEntry.cityGroups?: readonly (readonly number[])[]` --
//    a FRONTEND-ONLY field (deliberately not mirrored to the backend, which
//    doesn't need it -- `pathfinding.rs`'s simplified hex-level revenue
//    model never distinguishes which edge belongs to which city, only the
//    flat union). Set on the six genuine two-city tiles (NY x2, OO x5 -- OO
//    Green's `[[0], [2]]` was already effectively two independent
//    one-edge stubs even before this, but is now explicit): each entry is
//    that city's own live edges. `drawTrackPath`'s 3+-live-edge branch now
//    checks for `cityGroups` FIRST -- if present, each city draws its own
//    paired-edge curve into its OWN station point (`twoCityStationPoints`,
//    a new small helper factoring out the exact offset math the existing
//    station-circle placement already used, so track and circles can never
//    drift apart), instead of the old behavior of fanning EVERY live edge
//    from BOTH cities into one shared hub at hex center -- which was never
//    correct for a genuine two-city tile even before the bitmask fix, it
//    was just visually indistinguishable from correct while every tile was
//    fabricated as a symmetric 6-spoke fan. Single-city tiles (`B`,
//    ordinary `MajorCityHub`) have no `cityGroups` and keep the original
//    fan-to-center rendering, unchanged.

// 53. **Strip the #51 Shield Box; Extend Hex Boundary Clipping to Text.**
//    Two closing pieces, once #52's real (sparse) bitmasks made the
//    original problem #51 was solving mostly go away at the source:
//
//    (a) `drawHexNameLabel` no longer calls `drawLabelWithBackground` at
//    all -- back to a single plain `ctx.fillText` in solid `#000000`, no
//    box, per this pass's own explicit "strip all giant opaque cream/
//    yellow background shield boxes... render city text directly... in
//    simple, crisp, solid black" wording. #51's box existed because real
//    track was cutting through letterforms -- but with every city/OO/
//    landmark tile's connections now genuinely sparse (2-4 edges, not a
//    fabricated 6) instead of fanning from every direction, the upper-third
//    and dead-center bands these nameplates already sit in are clear of
//    track most of the time, so #51 was patching the symptom at the wrong
//    layer. `drawLabelWithBackground`/`NAMEPLATE_BOX_FILL_*`/`boxFill` are
//    all left in place, unused by `drawHexNameLabel` itself, in case a
//    specific still-crowded hex needs a targeted box later -- `boxFill`
//    stays a parameter of `drawHexNameLabel` (now ignored, via `void
//    boxFill`) so no call site needs its own signature change.
//
//    (b) Hex Boundary Clipping Mask (design note #42's `withHexClip`,
//    `ctx.save()`/hex-path/`ctx.clip()`/`ctx.restore()`) previously wrapped
//    only track-drawing calls (`drawTrackPath`/`drawLandmarkTrack`/
//    `drawOffboardTrack`/`drawPrintedTrack`) -- every `drawHexNameLabel`
//    call site (landmark names, gray/OO single names, OO stacked pairs,
//    double-town stacked pairs) now gets the identical treatment, so a
//    nameplate positioned close to its own hex's edge can never paint text
//    into the neighboring hex, regardless of how long the name is or how
//    tight `fitFontSize`'s shrink band gets.

// 54. **High-Contrast Light Shield Boxes (REVERSING #53's box removal) &
//    Unified Diagonal Node Geometry.** A follow-up request explicitly asks
//    the box back -- #53's own text left `drawLabelWithBackground`/
//    `NAMEPLATE_BOX_FILL_*` in place "in case a specific still-crowded hex
//    needs a targeted box later"; this is that request, applied uniformly
//    rather than to one specific hex. Three parts:
//
//    (a) `drawHexNameLabel` calls `drawLabelWithBackground` again -- a
//    TIGHT box (2px padding, 2px corner radius -- genuinely rectangular,
//    not #51's soft pill or `drawLabelWithBackground`'s own default
//    rounding, and never stroked) rather than #51's slightly looser one.
//    `boxFill` (a parameter since #50, ignored by #53's `void boxFill`) is
//    live again, but every call site now sources it from the new
//    `nameplateBoxFillFor` helper instead of a single hardcoded constant,
//    so the box is tier-color-matched: `NAMEPLATE_BOX_FILL_YELLOW`
//    (`#FEF08A`) for a Yellow tile or a printed-yellow hex with nothing
//    laid yet (landmarks, OO hexes), the new `NAMEPLATE_BOX_FILL_GREEN`
//    (`#DCFCE7`) for a laid Green tile, and the new
//    `NAMEPLATE_BOX_FILL_SLATE` (`#F1F5F9`) for a laid Brown tile, a real
//    GRAY preprinted hex, or any other ordinary (unprinted-color) hex --
//    matching the request's own "Brown / Gray / Off-Board Hexes" grouping.
//    `NAMEPLATE_BOX_FILL_DEFAULT` (the old flat cream used by the gray/named
//    and double-town passes) is retired in favor of the new SLATE constant,
//    which those same two passes now resolve to via the helper. Every one
//    of this file's FOUR `drawHexNameLabel` call sites is still gated by
//    `hexHasLaidTile`'s Dynamic City Nameplate Suppression (#47) -- so in
//    practice today only the Yellow and Slate branches are ever reached
//    through them (nothing here un-suppresses a post-lay nameplate); the
//    Green/laid-tile branch is still fully wired inside the helper itself
//    (real tile-color lookup via `TILE_CATALOG_BY_ID`, not a dead literal)
//    so the tier system is complete and correct rather than leaving Green
//    an unreachable stub.
//
//    (b) Unified Diagonal Node Geometry: the three double-town hexes
//    (Akron & Canton G7, Reading & Allentown G17, New Haven & Hartford
//    F20) previously used their OWN side-by-side layout (`hexSize * 0.28`
//    left-right) for their two dit markers -- visually inconsistent with
//    the OO double-city hexes' diagonal top-right/bottom-left circles
//    (`ooCityMarkerOffset`). Both now share the exact same helper and
//    offset -- `ooCityMarkerOffset`'s magnitude is also tightened from
//    #51's `0.49` to this request's own `~0.45`, so EVERY diagonal node
//    pair on the board (OO station circles, double-town dit markers, and
//    every downstream consumer of the same shared helper --
//    `stationMarkerPoint`'s OO anchor, `twoCityStationPoints`'s
//    `DoubleCityHub` branch for a laid tile) moves together, never drifting
//    apart the way two independently-hand-tuned constants could.
//
//    (c) Compact Stacked Nameplate Centering: the double-town name pass
//    moves from the upper-third band (`center.y - hexSize * 0.58 +/-
//    lineOffset`, shared with every single-name label) to TRUE HEX CENTER
//    (`center.y +/- lineOffset`) -- mirroring design note #49's identical
//    repositioning for the OO pass. With the dit markers now diagonal
//    (top-right/bottom-left) instead of side-by-side, true center is the
//    open channel between them, exactly as it already is for OO.

// 55. **Universal Canvas Layout Engine.** Replaces every remaining one-off,
//    per-hex-identity placement branch with a single shared system driven
//    entirely by TILE/TERRAIN DATA -- see the big block comment right above
//    `archetypeForHex` (search "UNIVERSAL CANVAS LAYOUT ENGINE") for the
//    full design; this entry is the top-of-file index pointer. Four parts:
//
//    (a) `HexArchetype` + `archetypeForHex`/`archetypeForTerrain`: classifies
//    ANY hex into SingleCity/DoubleCity/SingleTown/DoubleTown/Plain purely
//    from structural data (a laid tile's real terrain, or an un-laid hex's
//    OO/town-designation/city-designation/GRAY-marker/landmark-track-segment-
//    count) -- never a name/label string. REMOVES the one remaining literal
//    identity check in the file, `stationMarkerPoint`'s `hex.label ===
//    "G19"`, replacing it with "is this a landmark whose OWN
//    `LANDMARK_TRACKS` data has two real stub segments" (New York today, any
//    future same-shaped landmark automatically tomorrow). Also removes
//    `landmark.name === "Boston"/"New York"/"Baltimore"` from the
//    restriction-badge loop -- badge text ("B" vs "NY") is now read off the
//    SAME archetype classification, not a separate name comparison.
//
//    (b) Shared placement formulas: `doubleNodeOffset` (renamed/updated from
//    #54's `ooCityMarkerOffset`, now the request's own explicit `(+0.43 * R,
//    -0.25 * R)` top-right/bottom-left coefficients) for every two-node hex
//    with no real anchoring track of its own (OO, double-town, a laid
//    `DoubleCityHub` tile); `singleNodeNameplateAnchor` (`(x: -0.25 * R, y:
//    -0.35 * R)`, the request's own Upper-Left wedge) for every one-node hex
//    (landmarks' SingleCity case, gray/white single cities, single towns).
//    New York -- a DoubleCity landmark with REAL printed stub track -- keeps
//    its own authentic edge-anchored station geometry (`drawLandmarkTrack`)
//    rather than being forced onto the generic floating formula (moving a
//    station circle off the end of its own real rail would be a visual
//    regression, not an improvement), but its NAMEPLATE now uses the shared
//    DoubleCity dead-center anchor and "A & B" stacking rule exactly like
//    every other DoubleCity hex, dropping out of its old special-cased
//    single-name treatment.
//
//    (c) Strict Z-order: the one out-of-order pass (terrain build-cost
//    labels, previously drawn as pass #2 -- Layer 4 text content drawn
//    before ANY Layer 2/3 content) is split from its Layer 1 terrain icon
//    and moved down into the Layer 4 section, after every station/token
//    pass, alongside the other badges.
//
//    (d) Universal shield boxes + clipping: restriction badges ("B"/"NY"/
//    "OO", previously bare unframed text) and terrain cost labels
//    (previously a generic translucent-white box) now get the SAME tight
//    (2px padding, 2px corner radius, no stroke), tier-color-matched shield
//    box (`nameplateBoxFillFor`) every nameplate already has; the off-board
//    zone nameplate switches from a dark plate + light-pink halo text to the
//    same light SLATE box + solid black text. `withHexClip` (design note
//    #42) is extended to every remaining unclipped hex-rendering call this
//    pass touched (OO/town/city station markers, station token markers,
//    value badges, off-board nameplates) -- REMAINING SCOPED EXCEPTIONS,
//    documented at their own call sites rather than silently glossed over:
//    the Gulf/Canadian West MERGED nameplate (spans two real hexes by
//    design, so a single-hex clip would incorrectly bisect it) stays
//    unclipped, and city/town value badges keep their existing circular
//    high-contrast badge treatment (colored fill + dark stroke + white halo
//    text) rather than being redrawn as rectangles -- already a
//    high-contrast, tightly-bounded, board-tested design in its own right,
//    and out of this pass's scope to redesign wholesale.
//
// 56. **G19 Station Node Index Inversion Fix.** Reported via screenshot:
//    NYNH's (company 7/"NNH") home token rendered on G19's Bottom-Left/SW
//    circle instead of its canonical Top-Right/NE one. Root cause: #55's
//    rewrite of `stationMarkerPoint`'s landmark branch (removing the old
//    `hex.label === "G19"` check) anchored on `landmarkSegments[1]` -- the
//    SECOND/SW segment -- unconditionally, instead of the FIRST/NE segment
//    that the canonical "Node Index 0 = Top-Right/NE" rule requires. Fixed
//    by (a) anchoring `stationMarkerPoint`'s landmark branch on the exact
//    same literal `doubleNodeOffset` top-right point every other
//    `DoubleCity` hex uses, rather than any edge-derived approximation of
//    it; (b) rewriting `drawLandmarkTrack`'s one-edge-segment stub-station
//    formula to target that SAME canonical point, indexed by segment order
//    (segment 0 = Node 0 = NE, segment 1 = Node 1 = SW), so the real
//    printed track's own station circle and the corporate token marker can
//    never drift apart pixel-for-pixel; (c) merging `twoCityStationPoints`'s
//    stale, non-diagonal `NewYorkHub` left/right formula into the same
//    branch as `DoubleCityHub`, since both terrains now resolve to
//    identical Node 0/Node 1 coordinates. Every 2-station archetype (G19,
//    the four OO hexes, every double-town) now shares one literal formula
//    and one Node 0(NE)/Node 1(SW) convention, with no hex-name branching
//    anywhere in the chain. OO and double-town node order were already
//    correct under #55 and are unchanged by this fix.
//
// 57. **Laid Double-Town Tile Dit-Marker Standardization.** Coordinate-only
//    sweep to find and fix any remaining double-node call site not yet on
//    the shared diagonal formula: found one -- a laid `DoubleTown` tile #6's
//    OWN dit-marker pass (distinct from the unlaid `townDesignation:
//    "double"` marker pass #55 already fixed) still used an independently
//    computed, non-diagonal `size * 0.28` left/right pair. Fixed to use the
//    same shared coordinates as G19/OO/every other double-node hex. No
//    other outliers found; every double-node call site was audited.
//
// 58. **Single Shared 2-Node Coordinate Helper (`twoNodePositions`).**
//    Generalizes #56's G19 fix so the same class of bug (a call site
//    hand-deriving `center ± offset` and getting the sign wrong) can't
//    recur anywhere else. Adds ONE function, `twoNodePositions(center,
//    size)`, returning `[node0, node1]` -- index 0 always Top-Right/NE,
//    index 1 always Bottom-Left/SW -- built on top of `doubleNodeOffset`'s
//    existing `(+0.43 * R, -0.25 * R)` delta. Every double-city/double-town
//    call site (`stationMarkerPoint`'s OO and landmark branches,
//    `drawLandmarkTrack`'s stub-station branch indexed by `segmentIndex`,
//    `twoCityStationPoints`, `drawOOCityMarkers`, both the unlaid
//    `townDesignation: "double"` dit pass and the laid `DoubleTown` tile
//    dit pass) now calls this ONE function and indexes into its tuple by
//    its own already-existing city/segment/node index, rather than
//    re-deriving the `+`/`-` arithmetic locally at each site. Purely a
//    coordinate-plumbing change -- no dispatch condition (which hexes/tiles
//    count as "two-node") was altered, so every existing structural,
//    non-hardcoded classification (`HexArchetype`, `cityGroups.length`,
//    `LANDMARK_TRACKS` segment count, `townDesignation`) is unchanged.
//
// 59. **Lightweight Solid Black Dot Small-Town Primitive.** Primitive-
//    styling-only pass over `drawDitMarker` (the one function every small-
//    town/dit marker in the file draws through -- laid `SmallTown`/
//    `DoubleTown` tiles, pre-printed gray-hex towns, unlaid
//    `townDesignation` markers): fill changed from a near-black `#141414`
//    to a literal solid `#000000`, its `#d8d8d8` ring stroke removed
//    entirely (no border/outline/station-container styling of any kind),
//    and its radius shrunk from `size * 0.14` to `size * 0.08` -- about 36%
//    of `drawStationCircle`'s own `size * 0.22` city-circle radius, inside
//    the requested 30-40% band (later tuned up +40% to `size * 0.112` by
//    design note #60, a follow-up visual-feedback pass). Every call site's
//    own point/size arguments
//    (including the double-town `size * 0.85` scale-down and the diagonal
//    `twoNodePositions` coordinates feeding them) are UNCHANGED -- this
//    pass touched only what happens inside `drawDitMarker` itself, not
//    where or how large a scale factor calls it with; city station
//    circles, track spline routing, and all node-position math are
//    untouched.
//
// 60. **Small-Town Dot Size Follow-Up (+40%).** Visual-feedback pass after
//    seeing #59's `size * 0.08` dots rendered live -- reported as a bit too
//    small. Bumped to `size * 0.112` (`0.08 * 1.4`), still comfortably
//    smaller than `drawStationCircle`'s `size * 0.22` city circle (~51% of
//    it) so towns stay visually distinct from stations. Radius-only change,
//    same `#000000` fill, no stroke, no other call site touched.
//
// 61. **Small-Town Dot Size Follow-Up #2 (`size * 0.14`).** Still too small
//    at #60's `size * 0.112` -- bumped again, this time to an explicit
//    `size * 0.14` (~64% of `drawStationCircle`'s `size * 0.22`), the exact
//    radius MAGNITUDE `drawDitMarker` used before #59's rewrite (that
//    earlier version paired it with a `#141414` fill and a `#d8d8d8` ring
//    stroke; #59 already removed both, unchanged here). Still visibly
//    smaller than a city station circle. Radius-only change, same
//    `#000000` fill, no stroke, no other call site touched.
//
// 62. **Shape-Based Revenue Badge Iconography.** Replaces every
//    color-coded revenue-value badge fill on the board with one uniform
//    solid white (`#FFFFFF`) fill + `#1E293B` dark-navy stroke
//    (`lineWidth = 1.5`), carrying the city-vs-town distinction that color
//    used to encode via SHAPE instead: `drawValueBadge`'s badges (every
//    landmark, gray-hex city/town, yellow-OO hex, and laid SmallTown/
//    DoubleTown/MajorCityHub/DoubleCityHub tile) now render as a SQUARE for
//    MajorCityHub/DoubleCityHub and a DIAMOND for SmallTown/DoubleTown, via
//    the new `VALUE_BADGE_SHAPE` map (replacing `VALUE_BADGE_COLOR`); the
//    off-board zone revenue badge (`drawOffboardNameplate`'s own circular,
//    era-color-tier-coded badge) is now the SAME white SQUARE style,
//    grouped with city revenue per this pass's own explicit rule. Every
//    badge's number now renders in plain, unbolded (`font-weight: normal`)
//    solid black (`#000000`) text via a direct `ctx.fillText` -- no
//    dark-halo `fillTextWithHalo` stroke (that was contrast help for white
//    text on a variable-colored fill; black-on-white already has full
//    contrast on its own). The board's full shape-based iconography is now:
//    white circles = city stations, small solid-black dots = towns
//    (design note #59), white squares = city/off-board revenue, white
//    diamonds = town revenue. `drawBadgeShape`'s square is sized
//    (`radius * Math.SQRT1_2` half-side) so its own farthest corner sits at
//    exactly the same `radius` distance from center the old circle (and
//    the new diamond) reached, so none of `drawValueBadge`'s existing
//    corner-placement/hex-boundary-bleed-safety math needed to change.
//    Scope-limited to badge primitives only: badge center/corner-placement
//    logic, station circle rendering, track spline routing, and every
//    other text-placement calculation are untouched.
//
// 63. **Text-Driven Revenue Badge Sizing + Bold Text.** Reported: #62's
//    badges were too small and clipped their own numbers. Root cause was
//    the OLD sizing relationship, inherited unchanged from long before #62:
//    a fixed badge radius (`Math.max(6, size * 0.18)` for `drawValueBadge`,
//    `Math.max(7, hexSize * 0.24)` for the off-board badge) with the FONT
//    shrunk (via `fitFontSize`, down to a 5px floor) to whatever fit inside
//    it -- fine for a single-color pill where the exact radius didn't
//    matter much, but on the new white shapes a long value could shrink to
//    the point of crowding/clipping against the shape's own edge. Inverted
//    the relationship (design note #62's own doc comment already flagged
//    this as worth revisiting): both badges now fix a bold font first
//    (`Math.max(9, size * 0.2)` / `Math.max(9, hexSize * 0.24)`, never
//    shrunk) and size the badge SHAPE around the actual measured text via
//    the new `badgeRadiusForLabel` helper (mirroring the same "measure
//    text, size the box around it" approach `drawLabelWithBackground`
//    already uses for nameplate shield boxes elsewhere in this file), with
//    a floor at the old fixed radius so short values never shrink the
//    badge below its previous minimum size. Text also switched from plain
//    (`font-weight: normal`, #62's own choice) to BOLD, per this pass's
//    explicit request. Scope unchanged from #62: badge shapes/positions
//    and revenue-badge text only -- station circles, track splines, and
//    every other text-placement calculation in the file are untouched.
//
// 64. **Revenue Badge Tightening (-1pt Font, Tight Padding).** Reported:
//    #63's badges swung too far the other way -- too large, with visible
//    slack inside the shape. Two compounding causes, both fixed: (a) the
//    `badgeRadiusForLabel` floor (`Math.max(6, size * 0.18)` /
//    `Math.max(7, hexSize * 0.24)`) was still the OLD fixed-badge-era
//    radius, so it silently won out over the (smaller) text-fit
//    calculation for every ordinary 2-digit `$10`/`$20`/`$40` value --
//    dropped to a small flat `5` safety floor, letting the actual measured
//    text drive the size as originally intended; (b) padding was a
//    generous `4`/`3` -- tightened to this file's own established `2`/`1.5`
//    "tight shield box" convention. Font size also dropped 1pt (`- 1` off
//    each of `drawValueBadge`'s and the off-board badge's own font-size
//    formula), per this pass's explicit request. Same scope as #62/#63:
//    badge shape/size/text only.
//
// 65. **All-Square Revenue Badges + Another -1pt.** Reported: town
//    diamonds still took up too much room. Root cause is structural, not a
//    tunable constant -- `badgeRadiusForLabel`'s own doc comment derives
//    that a diamond needs radius `halfWidth + halfHeight` to clear a text
//    corner (its boundary tapers away from center on every side), while a
//    square only needs `max(halfWidth, halfHeight)`/`Math.SQRT1_2` -- a
//    diamond is inherently the larger shape for the same text, no amount
//    of padding/floor tuning fixes that. `VALUE_BADGE_SHAPE` now maps
//    every terrain (`SmallTown`/`DoubleTown` included) to `"square"`; the
//    board's iconography simplifies to white circles = city stations,
//    small black dots = towns, white squares = every revenue badge.
//    `drawBadgeShape`/`badgeRadiusForLabel` still support `"diamond"` as a
//    valid option (unused, not deleted). Font size also dropped ANOTHER
//    1pt (`- 2` off each font-size formula now, cumulative with #64) on
//    both `drawValueBadge` and the off-board badge. Same scope as
//    #62/#63/#64: badge shape/size/text only.
//
// 66. **Drop `$` Prefix, +1pt Font.** Both `drawValueBadge`'s `label` and
//    the off-board badge's `activeValue` now print the bare number
//    (`${value}`) instead of `$${value}` -- the white square shape already
//    unambiguously reads as a revenue badge on its own (#62's board-wide
//    shape iconography), so the symbol was redundant, and dropping it
//    leaves more of the tightly-fit square for the digits. Font size
//    bumped back up 1pt on both badges (`- 1` instead of #65's `- 2`, so
//    now -1pt net off the original #63 baseline, not -2pt). Same scope as
//    #62-#65: badge shape/size/text only.
//
// 67. **Scroll-Wheel Zoom Disabled.** `handleWheel`'s zoom-around-cursor
//    logic (the `setView`/`clampPanToBoard` update, identical math to the
//    "+"/"-" camera buttons) is REMOVED -- reported: manual buttons should
//    be the ONLY way to zoom, not an incidental scroll gesture over the
//    map. `handleWheel` now only calls `event.preventDefault()`, kept
//    unconditional and unchanged in purpose from design note #13 (stops
//    the page itself from scrolling while the cursor is over the canvas --
//    a scroll-containment concern, separate from zoom). The "+"/"-" button
//    handlers and every other zoom/pan path are untouched.
//
// 68. **Terrain Cost Badges Recolored Red/White, -1pt.** Reported: terrain
//    build-cost labels (Mountain/River hexes) needed to read as distinct
//    from revenue badges. The terrain-cost pass draws through
//    `drawLabelWithBackground` (a rounded-rect shield box), a different
//    primitive from `drawValueBadge`'s square/diamond `drawBadgeShape`
//    (#62-#66) -- already a different SHAPE, now also a different COLOR:
//    solid red (`#E53E3E`, this file's own established "crisp" red from
//    `drawImpassableBorderEdge`/design note #42, reused rather than a new
//    hex value) box with white (`#FFFFFF`) text, replacing the old
//    tier-colored box (`nameplateBoxFillFor`) with black text every other
//    board text element still uses. Font base size dropped 1pt (`9`
//    instead of `10`) in `fitFontSize`'s call. Scope-limited to this one
//    label pass -- every other `drawLabelWithBackground` caller
//    (nameplates, off-board names) keeps its existing tier-colored
//    styling untouched.
//
// 69. **Restriction Badges: Background Removed, Un-Bolded, +1pt.**
//    Reported: the "B"/"NY"/"OO" tile-upgrade-restriction badges' own
//    tier-colored shield box (added by #55, reversing #49's original
//    "no background" call) made them look like they sat on a separate
//    plate rather than being printed directly on the hex/tile -- unlike a
//    real 1830 tile's own restriction lettering, which is plain ink on the
//    printed tile face with no box. `drawRestrictionBadge` now calls
//    `drawLabelWithBackground` with `background: false` (the same
//    no-box escape hatch `drawBoardMarginLabels` already used), dropping
//    its now-unused `boxFill` parameter (and both call sites' own
//    `nameplateBoxFillFor` lookups, no longer needed) entirely rather than
//    leaving dead plumbing behind. Text also un-bolded (`"bold"` ->
//    no weight override) and sized up 1pt (base/min `10`/`7` -> `11`/`8`),
//    per this pass's explicit request. Every other badge type in the file
//    (revenue badges, terrain cost labels, nameplates) keeps its own
//    existing shield-box/bold/size treatment untouched.
//
// 70. **13-Slot Pointy-Topped Perimeter Anchor System.** Reported: replace
//    the file's various ad-hoc "vertical thirds"/fixed-corner positioning
//    literals with one shared, geometry-driven layout engine. Requirement
//    1 (confirm pointy-topped hex baseline) needed NO code change -- hand
//    verified `pointOnCircle`/`edgeAngleRad`/`cornerAngleRad` already
//    produce a vertex at true top/bottom (corners 2/5) and vertical edges
//    left/right (edges 0/3), i.e. already pointy-topped from the start.
//    Added a new 13-slot coordinate system (`hexSlotPoint`,
//    `hexSlotDirection`, slot 0 = center, slots 1-6 = edge midpoints,
//    slots 7-12 = corner vertices, in the requirement's own stated
//    compass order) plus occupancy helpers (`liveEdgesForHex`,
//    `hexBlockedSlots`, `slotsBlockedByEdges`, `pickHexSlot`) that mark a
//    slot BLOCKED when a track spline/station passes through it and pick
//    the first OPEN slot from a caller's own preference list, falling back
//    through progressively looser tiers exactly the way the pre-existing
//    `BADGE_CORNERS`/`drawValueBadge` tiered search already did (validated
//    by hand against all 4 of that search's `guardEdges` entries before
//    generalizing it). Four consumers now run through this shared engine
//    instead of their own private literals: `singleNodeNameplateAnchor`
//    (was a single fixed offset, now slot-12/upper-left first with a real
//    fallback -- special-cased to return the byte-identical old vector at
//    slot 12 itself, so the overwhelmingly common unblocked case is
//    pixel-identical to before), `drawValueBadge` (was `BADGE_CORNERS`,
//    now `BADGE_SLOT_PREFERENCE` -- same four corners, same tier order,
//    same `0.44 * size` magnitude, but now the true corner ANGLE rather
//    than a fixed 45-degree diagonal), `drawRestrictionBadge` (was a fixed
//    literal `cornerIndex`, now archetype-keyed preference lists with a
//    real fallback for the first time), and the terrain build-cost label
//    loop (was a fixed lower-third/bottom-right-quadrant literal, now
//    slot-10/bottom-point first for the default case -- byte-identical
//    direction to the old fixed vertical offset -- and slot-3/SE-edge
//    first for OO hexes). Scope constraint honored: `doubleNodeOffset`,
//    `twoNodePositions`, and every station-node coordinate are untouched.
//    HONEST GAP, flagged rather than silently worked around: Requirement
//    4 also asks to anchor "Tile IDs" clear of track -- this board does
//    not currently render a tile catalog ID number anywhere on a laid hex
//    (the only on-screen `tileId` text is an unrelated tile-picker preview
//    swatch); the terrain-cost label above is the closest existing
//    "bottom vertex / lower edge margin" element and was refactored
//    against that requirement instead, and the new engine is generic
//    enough to anchor a real on-board tile-ID label the same way if one is
//    added later.
//
// 71. **G19 (New York) Reclassified as a Real River Hex.** Reported, with a
//    reference screenshot of the real 18xx.games G19 tile: New York's own
//    printed hex carries a water icon and an "$80" terrain build cost this
//    file never rendered, because `STATIC_BOARD_HEXES`' G19 entry was typed
//    `"Plain"`. VERIFIED against this file's own established source
//    (design note #6: `tobymao/18xx`'s `lib/engine/game/g_1830/map.rb`)
//    before changing anything, per this file's standing "never guess,
//    cross-check the real source" rule: G19's real HEXES entry reads
//    `'city=revenue:40;city=revenue:40;path=a:3,b:_0;path=a:0,b:_1;
//    label=NY;upgrade=cost:80,terrain:water'` -- `terrain:water`/`cost:80`
//    confirms the screenshot exactly, and matches this file's own existing
//    `TERRAIN_BUILD_COST_LABEL.River = "$80"` constant precisely (no new
//    figure invented). Fixed by changing G19's `type` from `"Plain"` to
//    `"River"`, alongside its existing `printedColor: "Yellow"` -- the
//    EXACT SAME field combination `YELLOW_OO_HEXES`' own two real river
//    hexes (D10/Hamilton & Toronto, E5/Detroit & Windsor) already use (see
//    `YELLOW_OO_HEXES`'s own doc comment), so this isn't a new code path,
//    just G19 correctly joining an already-proven one.
//
//    KNOCK-ON FIX, required for correctness, not just requested: the
//    terrain-icon and terrain-cost-label passes both used to gate their
//    off-center "clear of the two station circles/nameplate" positioning on
//    `YELLOW_OO_HEXES.has(hex.label)` specifically -- a NAME-keyed check
//    that would have silently centered a full-size river icon directly on
//    top of G19's own two NNH/landmark station circles and nameplate the
//    moment G19 became a River hex, since G19 was never in that OO-only
//    set. Generalized both checks to `archetypeForHex(mapGrid, hex.q,
//    hex.r) === "DoubleCity"` instead -- the STRUCTURAL condition the old
//    OO-specific one was really standing in for all along (this file's own
//    established "no hex-name-literal branching on where to draw" rule,
//    design note #53) -- so G19 now automatically gets the identical
//    off-center icon/label treatment the two OO rivers already do, no
//    G19-specific literal added anywhere.
//
//    CROSS-CHECKED against the reference screenshot's own Vertex/Edge
//    numbering (screen-relative, clockwise from the true top vertex): the
//    13-slot engine (design note #70) already resolves G19's revenue
//    badges to its Vertex 1/Vertex 4 corners and its "NY" restriction badge
//    to its Vertex 5 corner, all matching the reference, purely as a
//    consequence of G19's own two live stub-track edges (`LANDMARK_TRACKS`
//    edges 1/NE and 4/SW) blocking the other four corner slots -- no
//    G19-specific code exists for any of those either. HONEST CAVEAT: the
//    reference places the water icon/cost right at Vertex 2 itself; the
//    generalized engine (preference `[3, 9, 10, 11]`) lands G19's own
//    instance one slot over, on the adjacent SE edge midpoint (slot 3),
//    since Vertex 2 itself (slot 9) is NOT actually blocked here but sits
//    later in that same shared preference list used by the two OO rivers
//    too -- visually in the same corner/quadrant, not pixel-identical to
//    the reference's exact vertex, and not special-cased further to avoid
//    reintroducing a hex-specific literal for one pixel of precision.
//
// 72. **Cross-Pass Slot Claiming.** Reported via screenshot, AFTER #70/#71:
//    on New York (G19), the revenue badge, the terrain-cost label, and the
//    terrain icon still rendered stacked on top of each other. Root cause:
//    every slot-picking pass (terrain icon, restriction badge, terrain-cost
//    label, revenue badge) called `pickHexSlot` independently, each blind
//    to what any OTHER pass had already drawn on the SAME hex -- harmless
//    everywhere no two passes' own short preference lists ever favored the
//    same slot, but G19's two real stub track edges block four of its six
//    corners, leaving only two open, and three separate passes all
//    independently picked the SAME one. Fixed with `claimHexSlot`, ONE
//    `Map<"q,r", Set<slot>>` ledger (`claimedHexSlots`) created fresh at
//    the top of this whole block of passes and threaded through all four,
//    in their existing draw order (icon, restriction, cost, badge): each
//    call unions its own hex's already-claimed slots into what counts as
//    "blocked" before picking, then records its own pick so the next pass
//    on that hex avoids it too. Paired with a new `extendSlotPreference`
//    helper so a pass whose own short list (e.g. `BADGE_SLOT_PREFERENCE`'s
//    four corners) is entirely taken by live track and prior claims falls
//    through to any OTHER open slot on the hex (a `CORNER_SLOTS`-only pool
//    for `drawRestrictionBadge`, which has no edge-slot rendering path;
//    every slot for everything else) instead of the old tier-4 "first
//    candidate anyway" landing back on top of live track or another label.
//    The terrain icon's own DoubleCity positioning (previously design note
//    #71's fixed `{0.36, 0.32}` literal offset) is now ALSO slot-driven
//    through this same ledger, sharing `DOUBLE_CITY_TERRAIN_SLOT_PREFERENCE`
//    with the terrain-cost label so the two stay paired when both are free
//    to take their shared first choice. A hex with only one or two of
//    these four features (the overwhelming majority of the board) is
//    completely unaffected -- `claimedHexSlots` starts empty for every hex,
//    so only a genuinely crowded landmark hex like G19 ever reaches a
//    fallback slot at all.
//
// 73. **Two-Node Offset: Edge Midpoints, Not a Diagonal.** Explicit
//    instruction, after #55's original diagonal offset was shown (by the
//    same G19 reference screenshot #71 verified against) to land almost
//    exactly ON a hex vertex (`(+0.43, -0.25)` resolves to -30.17 degrees,
//    0.17 degrees off `cornerAngleRad(1)` exactly) instead of an edge
//    midpoint the way the real board prints it: "scrap the earlier offset
//    rules... instead set them so that one city/town marker is at (what I
//    call) Edge 0 and the other is at Edge 3." `doubleNodeOffset` REPLACED
//    WHOLESALE -- no longer a hand-picked `(+0.43, -0.25)` diagonal
//    coefficient pair, now `pointOnCircle` along this file's own edge 1 (NE,
//    the user's own "Edge 0") at a magnitude pulled in from the true
//    apothem (`size * sqrt(3)/2`) by the station circle's own `size * 0.22`
//    radius (`drawStationCircle`) plus a visible safety margin, so the
//    circle never bleeds past the hex's printed border the way a
//    full-apothem placement would. Edge 4 (SW, the user's own "Edge 3") is
//    exactly opposite edge 1 (180 degrees apart), so `twoNodePositions`'
//    existing `center + delta`/`center - delta` structure (design note #58)
//    needed NO changes at all -- only the delta vector itself did. BOARD-
//    WIDE by construction, same as every prior pass touching this function:
//    every double-node hex (New York, all five OO `DoubleCityHub` variants,
//    every double-town) moves together, since none of them compute their
//    own offset independently.
//
// 74. **Nameplates Join Cross-Pass Slot Claiming; Bottom-Vertex Fallback
//    Promoted.** Reported via screenshot (Baltimore/I15: nameplate, "B"
//    restriction badge, and revenue badge all overlapping) that #72's
//    cross-pass claiming ledger didn't actually fix every collision --
//    root cause: `singleNodeNameplateAnchor` was never migrated off the
//    raw `pickHexSlot` call, so it stayed completely invisible to (and
//    unaware of) every OTHER pass's claims. Concretely, on Baltimore
//    (real printed edge-0/edge-4 through-route), BOTH the nameplate's own
//    `NAMEPLATE_SLOT_PREFERENCE` and the restriction badge's
//    `RESTRICTION_SLOT_PREFERENCE_OTHER` independently resolved to the
//    SAME upper-left corner (the one corner Baltimore's track leaves open),
//    landing exactly on top of each other -- `claimHexSlot` alone can't
//    prevent that when one of the competing passes never calls it. Fixed:
//    `singleNodeNameplateAnchor` now takes the same `claimedHexSlots`
//    ledger every other pass does and calls `claimHexSlot`, and both of
//    its call sites (the landmark SingleCity pass, the gray/named-hex
//    pass) now pass it through -- nameplates are the FIRST of these passes
//    to run each render, so the common case (nothing else competing for
//    upper-left) is unaffected, exactly as before.
//
//    SEPARATELY, reported: Fall River (F24) and Atlantic City (I19) --
//    real gray connector hexes with track fanning out in several
//    directions -- had their nameplates landing on top of a track spline
//    despite not being "blocked" by the letter of the rule, because
//    `NAMEPLATE_SLOT_PREFERENCE`'s old order tried all six EDGE slots
//    (each one sitting where a spline actually runs) before ever reaching
//    the bottom vertex, a perfectly good corner it treated as almost a
//    last resort. Reordered to try the bottom vertex (slot 10) SECOND,
//    right after the default upper-left, per the user's own explicit
//    suggestion -- a busy hex with every upper corner blocked now lands
//    there instead of on an edge.
//
// 75. **Adaptive Quadrant for the Coordinate Hover Tooltip.** Reported: the
//    off-board hover tooltip (`drawOffboardTooltip`, design note #15/item 4)
//    already flips toward whichever quadrant has room, but this file's
//    OTHER tooltip -- the DOM `position: fixed` "{label}: {name} (Value:
//    $X)" card that follows the cursor over every hex, board-wide (design
//    note #21) -- always anchored `clientX + 14`/`clientY + 14`, sitting
//    down-right of the cursor unconditionally, so it ran past the panel's
//    own edge for any hex near the panel's right or bottom side (Boston,
//    Fall River). `handlePointerMove` now also computes `preferLeft`/
//    `preferAbove` from the cursor's position within the CANVAS's own
//    bounding rect (already computed there for the hex hit-test, so this
//    is free) relative to its own midpoint -- not the browser window's,
//    so the flip threshold tracks the panel's actual edges even if the
//    canvas doesn't fill the full viewport. The tooltip's JSX then swaps
//    `left`/`top` for `right`/`bottom` (both still viewport-anchored,
//    `position: fixed`) on whichever axis needs to flip, so the corner
//    nearest the cursor is always the one INSIDE the panel.
//
// 76. **Far-Side Fallback for Badge/Restriction on Crowded DoubleCity Hexes.**
//    Reported, still on G19 after #72/#74's claiming fixes: the revenue
//    badge, terrain-cost label, and terrain icon rendered at three
//    mathematically DISTINCT slots (verified) but still read as visually
//    stacked. Root cause, one level deeper than #72: G19's own two live
//    stub edges leave only two open corners (9, 12) and four open edges (2,
//    3, 5, 6) -- so once the terrain icon and terrain-cost label claim two
//    of those (their own shared near-side preference, `[3, 9, 10, 11]`,
//    unchanged), the revenue badge's own four corner preferences are ALL
//    either live-track-blocked or already claimed, and it fell through to
//    `extendSlotPreference`'s purely neutral ascending fallback -- which
//    handed back slot 2 (0 degrees), immediately adjacent to the icon/cost
//    pair it was trying to avoid (30/60 degrees). `BADGE_SLOT_PREFERENCE`
//    and `RESTRICTION_SLOT_PREFERENCE_DOUBLE_CITY` now each list the two
//    FAR-side edge slots (6/NW, 5/W -- 180/240 degrees, the opposite side of
//    the hex from the icon/cost cluster) as an explicit early fallback,
//    ahead of the neutral tail. Common case unaffected (badge/restriction
//    both still take their own first-preference corner whenever it's open,
//    exactly as before); only a hex this crowded ever reaches the new far-
//    side entries, and now lands genuinely clear of the icon/cost pair
//    instead of merely technically-unclaimed.
//
// 77. **Two-Node Offset Pulled In Further, size*0.58 -> size*0.50.** Reported:
//    after #73 moved station circles onto their edge midpoints, the real
//    track stub connecting the hex's edge to the station -- the visible
//    proof of a valid route connection -- was nearly invisible, squeezed
//    into a bare `0.066 * size` gap between the `0.58`-magnitude circle and
//    the `0.866 * size` apothem boundary. Pulled in to `size * 0.50`
//    (`0.146 * size` clearance, over double), a "very small amount" per the
//    request's own framing -- direction unchanged, only the distance from
//    center. Board-wide by construction, same as #73: every double-node
//    hex moves together.
//
// 78. **Nameplate Typography/Shield Standardization, Off-Board Combined
//    Nameplate+Revenue Block, G19 Display Name.** Explicit scope constraint
//    honored: the 13-slot placement algorithm itself (WHICH slot a
//    nameplate/badge/icon claims) is UNCHANGED by this pass -- every edit
//    below is typography/fill/grouping only, layered on top of whatever
//    anchor point the existing #70/#72/#74/#76 slot-claiming system already
//    picked.
//    (a) `drawHexNameLabel`'s tier-color-matched shield box
//    (`nameplateBoxFillFor`/`NAMEPLATE_BOX_FILL_YELLOW`/`_GREEN`/`_SLATE`,
//    #54) is REPLACED by a single flat semi-transparent white
//    (`rgba(255, 255, 255, 0.75)`), going fully opaque
//    (`rgba(255, 255, 255, 1.0)`) on hover -- the `boxFill` parameter is
//    dropped from every call site since the fill no longer varies by tile
//    color/tier. `nameplateBoxFillFor` and the three `NAMEPLATE_BOX_FILL_*`
//    constants are left defined (dead code) rather than deleted, to keep
//    this diff purely additive/subtractive at the call sites instead of
//    touching unrelated plumbing.
//    (b) Font weight for every nameplate (landmark, gray/named hex, OO/
//    double-town stacked halves, off-board zone names) drops from always-
//    bold (#51) to REGULAR -- `fitFontSize`'s `fontWeight` argument changes
//    from `"bold"` to `""` at every nameplate call site. `NAMEPLATE_FONT_SIZE_PX`/
//    `_MIN_PX` move from 10/8 to 11/9, and the off-board nameplate's own
//    previously-independent 10/6 literals are replaced with the same two
//    shared constants, so EVERY nameplate on the board (on-board and off-
//    board alike) now renders at one uniform crisp scale instead of two
//    slightly different ones. Revenue/terrain-cost BADGE text (a distinct
//    element from a nameplate, per this file's own long-standing square/
//    diamond badge-shape iconography) is deliberately left bold -- out of
//    this pass's "nameplates" scope.
//    (c) `drawOffboardNameplate` (the red off-board zone name + revenue
//    pass) is rewritten from two independently hex-relative-offset pieces
//    (name pinned `hexSize * 0.42` above center, badge pinned `hexSize *
//    0.44` below, regardless of how many name lines there were) into one
//    combined block: total block height is computed from the ACTUAL name
//    line count plus the badge's own measured diameter, then the whole
//    block is centered so its own vertical midpoint lands exactly on the
//    hex's center -- the badge sits immediately beneath the name text
//    (small proportional gap, `hexSize * 0.08`) rather than at a fixed
//    hex-relative offset that happened to look adjacent only for the
//    common one-line-name case. Falls back to badge-only, centered exactly
//    on the hex, when `showCityNames` is off (no name lines to combine
//    with). Also picked up the new white translucent shield box from (a),
//    replacing its own previous `NAMEPLATE_BOX_FILL_SLATE`.
//    (d) G19's nameplate now reads "New York & Newark" (was "New York"),
//    matching the physical tile and triggering the SAME stacked-two-line
//    " & " format the OO/double-town passes already use -- via a new
//    optional `LANDMARK_HEXES.displayName` field, so `LANDMARK_TRACKS`
//    and every other lookup keyed on the landmark's real, unchanged
//    `.name` ("New York") stays exactly as it was.
//
// 79. **Single-Node Nameplate Wrap-Not-Shrink (follow-up to #78).**
//    Reported: Lancaster, Atlantic City, Fall River, Columbus, Baltimore,
//    Washington D.C., Rochester, Kingston, Cleveland, and Providence
//    rendered visibly SMALLER than every other nameplate -- #78's own
//    "one uniform size" standardization wasn't actually uniform, because
//    the single-node nameplate pass (every gray/named hex, plus Boston/
//    Baltimore) still ran each name through `fitFontSize`'s per-name
//    shrink-to-fit against a tight `hexFlatWidth * 0.55` budget: short
//    names (Boston, Toledo, Albany, ...) fit at the full
//    `NAMEPLATE_FONT_SIZE_PX` untouched, longer ones didn't and silently
//    shrank toward `NAMEPLATE_FONT_MIN_PX` instead. New `drawSingleNodeNameplate`
//    wraps a multi-word name onto two stacked lines (same first-space
//    split the OO/double-town/off-board passes already use) around the
//    SAME anchor `singleNodeNameplateAnchor` picked, rather than shrinking
//    it onto one; a single-word name with no space to wrap at instead gets
//    a much wider budget (`hexFlatWidth * 0.92`, matching the off-board
//    pass's own value) so it no longer needs to shrink either. Purely a
//    text-layout change at an already-chosen anchor point -- does not
//    touch the 13-slot placement/claiming system.
//
// 80. **Nameplate Font Size -4pt.** Reported too large at #78's 11/9 --
//    `NAMEPLATE_FONT_SIZE_PX`/`_MIN_PX` dropped to 7/5, same shared
//    constants every nameplate (on-board and off-board) still draws from.
//
// 81. **Nameplate Font Size, Try 8pt.** #80's 7/5 tried next size up, per
//    direct request -- 8/6, same shared constants.
//
// 82. **Nameplate Shield +20% Transparency.** `NAMEPLATE_SHIELD_FILL`
//    dropped from `rgba(255,255,255,0.75)` to `rgba(255,255,255,0.55)`,
//    per direct request -- hover fill unchanged (still fully opaque).
//
// 83. **Nameplate Wrap Rule: Ampersand Only, Plus One Named Exception.**
//    Per explicit rule: a nameplate wraps onto two stacked lines ONLY when
//    it names two separate cities via an ampersand ("A & B" -- the OO/
//    double-town/landmark-DoubleCity passes already implement this via
//    their own `.split(" & ")`, unchanged by this pass), with ONE named
//    exception, "Maritime Provinces" (too long for its single hex on one
//    line despite naming only one place). REVERSES #79's "any multi-word
//    single-node name wraps at its first space" and #47's "any multi-word
//    off-board zone name wraps" defaults -- `drawSingleNodeNameplate` no
//    longer wraps at all (no single-node name has an ampersand or is the
//    Maritime Provinces exception), and `drawOffboardNameplate` now wraps
//    via the new `offboardNameplateLines` helper, which special-cases only
//    "Maritime Provinces" -- "Canadian West" and "Deep South" render as a
//    single line now. The #79/#78 width-widening fix (`hexFlatWidth *
//    0.92`, so long single-line names don't need to shrink) is UNCHANGED.
//
// 84. **Unified Two-Line Nameplate Shield (removes overlap-darkening
//    seam).** Reported: on a two-line nameplate, the shared band where
//    line 1's own background box and line 2's own background box
//    overlapped read as a visibly darker patch -- #82's 0.55-alpha white
//    boxes, drawn independently per line, compositely stacked their alpha
//    wherever they overlapped. New `drawStackedNameLabel` (paired with an
//    extracted `fillRoundedRect` primitive, shared with
//    `drawLabelWithBackground`'s own box) measures BOTH lines, unions
//    their two padded boxes into ONE rect, and fills it ONCE -- no
//    overlap, no seam, regardless of the two lines' relative widths. Also
//    picks one SHARED font size for the pair (the smaller of each line's
//    own independent `fitFontSize` result) so a length mismatch between
//    the two words can't produce a visible size mismatch either. Wired
//    into every #83 two-line case: OO double-city, double-town, landmark
//    DoubleCity (New York & Newark), and off-board Maritime Provinces.
//
// 85. **Off-Board Block Order Flipped: Badge on Top.** Per direct request,
//    `drawOffboardNameplate`'s combined block (design note #78c) now
//    stacks the revenue badge ABOVE the name text (was name above, badge
//    below) -- the block's own total height, dead-center anchoring on the
//    hex, and the gap between the two pieces are all otherwise unchanged.
//
// 86. **Water Terrain Icon Redesign: Thin Double Strand.** `drawRiverIcon`
//    now strokes its gentle S-curve TWICE, as two thin, tightly-stacked
//    parallel strands (`iconSize * 0.09` apart), rather than once at the
//    old thicker width -- reads more clearly as a cartographic "water"
//    symbol. Stroke width dropped 75% (`Math.max(3, iconSize * 0.14)` ->
//    `* 0.25`). `drawMountainIcon` unchanged visually, but both icon
//    functions gained an optional `colorOverride` param for design note #87
//    below.
//
// 87. **Compound [Icon + Cost] Badges on Complex Hexes, One Slot Claim.**
//    Per explicit request: a "complex" hex -- one with a city/town
//    archetype OR real live track (`isComplexHex`, replacing the old
//    DoubleCity-only `isDoubleCityHex` check, which MISSED the SingleCity
//    `cityDesignation` River hexes -- Toledo/F4, Providence/F22,
//    Washington D.C./J14 -- those rendered a full-size, dead-CENTERED icon
//    directly under their own revenue badge/nameplate) -- no longer draws
//    a standalone Layer-1 terrain icon at all. Instead, the Layer-4
//    terrain-cost pass draws ONE compound pill (new
//    `drawTerrainCompoundBadge`) containing the icon (shrunk to the cost
//    text's own cap-height, in WHITE via the icon functions' new
//    `colorOverride`, via the new `drawTerrainIcon` dispatcher) immediately
//    adjoined to the cost figure, both on one shared solid-red
//    (`fillRoundedRect`) plate. This whole badge claims exactly ONE slot
//    from `claimedHexSlots` (`COMPLEX_HEX_TERRAIN_SLOT_PREFERENCE`, the
//    renamed-unchanged `DOUBLE_CITY_TERRAIN_SLOT_PREFERENCE`) -- REPLACING
//    the old two-claim split (one for the icon in the Layer-1 pass, a
//    second for the cost box here). A simple hex (no city/town/track) is
//    completely unaffected: standalone icon at center, standalone cost box
//    at its own claimed slot, exactly as before.
//
// 88. **Water Wave Follow-Up + Icon Moved Above (Not Inside) the Compound
//    Badge.** Two direct-feedback fixes on #86/#87:
//    (a) `drawRiverIcon` reshaped again -- from one gentle two-arc S-curve
//    (still read as "a river," not "waves") to a proper tilde-style wave,
//    THREE alternating crests/troughs via new `drawWaveStrand`, the
//    standard nautical-chart water glyph. Stroke width bumped +25% off
//    #86's own thinned value (net `* 0.3125` off the original pre-#86
//    formula, not #86's `* 0.25`), and the two strands pulled further
//    apart (`iconSize * 0.09` -> `* 0.16`).
//    (b) `drawTerrainCompoundBadge` (#87) revised: the icon no longer sits
//    INSIDE the red cost box -- it now perches directly ABOVE it instead,
//    in its own ordinary terrain color (the white `colorOverride` is no
//    longer used here), both pieces laid out as one vertically stacked
//    block centered on the badge's single claimed slot. The red box now
//    holds ONLY the cost text again, same as a simple hex's plain cost
//    box.
//
// 89. **Compound Badge Icon Width Now Exactly Matches Cost Box Width.**
//    Per direct request, the terrain icon perched above the compound
//    badge's red cost box (#88) is now sized so its rendered width
//    exactly equals the box's width, rather than being derived from the
//    cost text's cap-height. New constant `TERRAIN_ICON_SIZE_RATIO`
//    records each icon's own width-per-`size` and height-per-`size`
//    ratios, derived directly from `drawRiverIcon`'s/`drawMountainIcon`'s
//    internal geometry formulas. `drawTerrainCompoundBadge` now computes
//    `iconSize = boxWidth / ratio.width` (guaranteeing the width match)
//    and derives `iconRenderedHeight = iconSize * ratio.height` from
//    that, using the derived height (not the old text-height guess) for
//    the vertical stacked-block layout math.
//
// 90. **Water Wave Icon: Third Crest Added.** Per direct request,
//    `drawWaveStrand` (#88) now strokes FIVE segments (three crests, two
//    troughs) instead of three (two crests, one trough), within the SAME
//    overall `[startX, endX]` span and `amplitude` -- so the strand's own
//    bounding width/height are unchanged and `TERRAIN_ICON_SIZE_RATIO`
//    (#89) needed no update. Since both the standalone terrain-icon pass
//    (simple hexes) and `drawTerrainCompoundBadge`'s perched icon (complex
//    hexes) call the same shared `drawRiverIcon` -> `drawWaveStrand` path,
//    this one change reaches both render sites automatically.
//
// 91. **Terrain Cost Red Box Tightened to the Number.** Per direct
//    request, both red terrain-cost boxes -- the plain-hex standalone box
//    (`drawLabelWithBackground` call, design note #68) and the compound
//    badge's box (`drawTerrainCompoundBadge`, #87-89) -- had their padding
//    tightened (2/2 -> 1/1, and 3/2 -> 1/1, respectively) so the red fill
//    hugs the cost figure more closely. Originally marked as a TRY-FIRST
//    fix, with a possible fallback of reverting this padding and instead
//    dropping the font 1pt -- superseded by #92 below, which keeps this
//    padding AND drops the font, per direct follow-up request.
//
// 92. **Terrain Cost Font Also Dropped 1pt, Padding Kept.** Per direct
//    follow-up on #91: rather than reverting the tightened padding, the
//    cost text's base font size is ALSO dropped 1pt (`9` -> `8`) in both
//    call sites -- the plain-hex box and `drawTerrainCompoundBadge` --
//    layering on top of, not replacing, #91's tighter padding. Min font
//    size (`6`) is unchanged in both.
//
// 93. **Compound Badge: Icon/Box Gap Widened.** Per direct request, the
//    small fixed gap between the compound badge's perched terrain icon
//    and its red cost box below (`drawTerrainCompoundBadge`'s `iconGap`,
//    #88) is widened `1.5 -> 3` -- the two pieces were reading as directly
//    touching. Still small enough that they read as one combined unit,
//    not two separate ones.
//
// 94. **Terrain Cost Badge: `$` Dropped.** Per direct request,
//    `TERRAIN_BUILD_COST_LABEL`'s two values ("$80"/"$120") drop their `$`
//    prefix (now "80"/"120") -- the red box itself already unambiguously
//    marks this as a cost, so the bare number reads cleanly alone. Both
//    render paths (plain-hex box and the compound badge) pick this up
//    automatically since they just render whatever string the constant
//    holds.
//
// 95. **Water Icon Third Crest Made Legible; Terrain Cost Font Raised
//    Back 1pt.** Two follow-up fixes, per direct feedback: (a) #90's third
//    wave crest was mathematically correct but too subtle to actually
//    read at the icon's small on-screen size -- `drawRiverIcon`'s
//    `amplitude` is bumped `iconSize*0.16 -> iconSize*0.24`, and
//    `TERRAIN_ICON_SIZE_RATIO.River.height` updated `0.224 -> 0.28` to
//    match (the icon's own bounding height grows with it; width is
//    unaffected). (b) Now that #94 dropped the `$` prefix, the terrain
//    cost font -- dropped a total of 2pt across #68/#92 -- is raised back
//    1pt (base `8` -> `9`, min unchanged at `6`) in both the plain-hex box
//    and `drawTerrainCompoundBadge`, since the freed-up horizontal room
//    from losing the `$` allows it.
//
// 96. **Water Icon: Even Segment Count for THREE Full Waves.** Per direct
//    follow-up ("only seeing two waves," even on the larger simple-hex
//    icon, after #95's amplitude bump): `drawWaveStrand`'s ODD 5-segment
//    count (#90 -- three crests, two troughs, 2.5 cycles, starting AND
//    ending on an up-crest) still read as "two waves" since the trailing
//    half-cycle doesn't register as a distinct third wave to count. Now
//    EVEN, 6 segments -- three crests, three troughs, three FULL
//    crest+trough cycles -- an unambiguous count of three. Strand now
//    starts up/ends down (was up/up); same overall span and `amplitude`,
//    so no `TERRAIN_ICON_SIZE_RATIO` change needed on top of #95's.
//
// 97. **Terrain Cost Red Box Padding Reverted.** Design note #91's
//    tightened padding (2/2 -> 1/1 plain-hex box, 3/2 -> 1/1 compound
//    badge box) is reverted back to its original values in both places,
//    per direct request -- the terrain-cost font-size drop (#92, raised
//    partway back by #95) stays as the fix for this box's sizing instead.
//
// 98. **Water Icon: THIRD STRAND Added (Clarifying #90/#96's "Third
//    Wave"/"Only Two Waves" Exchange).** Turns out "add a third wave" and
//    the later "still only seeing two waves" report meant a third
//    PARALLEL LINE in the icon's existing two-strand shape, not a third
//    crest crammed into one line -- #90 (5-segment/3-crest single line)
//    and #96 (6-segment/3-cycle single line) both approached the wrong
//    problem and are reverted; `drawWaveStrand` is back to its original
//    #90 5-segment shape. `drawRiverIcon` now strokes THREE stacked
//    strands (`-strandOffset`, `0`, `+strandOffset`) instead of two (was
//    `-strandOffset/2`, `+strandOffset/2`), each strand the same shape,
//    same `strandOffset` gap between every adjacent pair as the old
//    layout's one pair had. `TERRAIN_ICON_SIZE_RATIO.River.height`
//    updated `0.28 -> 0.392` for the taller three-strand bounding box
//    (width ratio unaffected).
//
// 99. **Terrain Cost Font Raised Another 1pt.** Per direct request, the
//    cost text's base font size -- `9` after #95's partial restore -- is
//    raised another 1pt to `10` in both the plain-hex box and
//    `drawTerrainCompoundBadge`. Min font size (`6`) unchanged.
//
// 100. **Water Icon: Third Strand Removed; Remaining Two Spaced Further
//    Apart.** Per direct request, `drawRiverIcon`'s third strand (#98) is
//    removed -- back to two stacked strands, the original #86 layout.
//    `strandOffset` (the gap between the two strands) is also widened
//    `iconSize*0.16 -> iconSize*0.20` for slightly more separation.
//    `TERRAIN_ICON_SIZE_RATIO.River.height` updated `0.392 -> 0.308` to
//    match the new (shorter than three-strand, slightly taller than the
//    original two-strand) bounding height; width ratio unaffected.
//
// 101. **Mountain Icon Enlarged 25%.** Per direct request,
//    `drawMountainIcon`'s `iconSize` is bumped `size*0.7 -> size*0.875` --
//    every other dimension in that function (`w`, `h`, `cx`/`cy` offsets)
//    derives from `iconSize`, so this one change uniformly scales the
//    whole icon up 25%, both peaks included. `TERRAIN_ICON_SIZE_RATIO.
//    Mountain` updated to match: `width 0.4865 -> 0.608125`, `height
//    0.294 -> 0.3675` (both simply the old values times 1.25), so the
//    compound badge (#89) keeps sizing this icon to an exact target width.
//
// 102. **Mountain Icon Enlarged Another 30%.** Per direct follow-up
//    request, `drawMountainIcon`'s `iconSize` is bumped another 30%,
//    `size*0.875 -> size*1.1375` (net `1.625x` the original `size*0.7`).
//    `TERRAIN_ICON_SIZE_RATIO.Mountain` updated to match: `width
//    0.608125 -> 0.7905625`, `height 0.3675 -> 0.47775` (both simply
//    #101's values times 1.3), keeping the compound badge's exact-width
//    sizing (#89) accurate.
//
// 103. **Tooltip: Suppress "$0" Value; Add Terrain Cost.** Two follow-up
//    fixes to `describeHexWithValue`, per direct request. (a) The
//    "(Value: $X)" suffix is now suppressed for `X === 0` -- reversing
//    design note #35/#37's deliberate choice to keep a literal
//    "(Value: $0)" in the tooltip for hexes whose on-canvas badge is
//    itself hidden at $0; only an actual nonzero value gets the suffix
//    now, on both the flat `hexRouteValue` path and the off-board
//    `offboardValueForEra` path. `hexRouteValue`'s own return value is
//    unchanged (still literally `0` for those hexes) -- only this
//    tooltip-text formatting layer changed. (b) A new "(Terrain Cost: $Y)"
//    suffix is appended for any Mountain/River hex, reusing
//    `TERRAIN_BUILD_COST_LABEL` (same source as the on-canvas red cost
//    badge, #68/#87) -- its values are bare digits since #94 dropped their
//    `$` prefix for that badge, so a `$` is re-added here for this
//    text-sentence context.
//
// 104. **13-Slot Engine: Minimum 120-Degree Angular Separation Between
//    Claimed Slots.** Explicit task, scope EXPANDS the standing "do not
//    refactor the 13-slot placement algorithm" constraint every prior
//    typography-only pass (starting #78) had deliberately honored --
//    this pass is specifically ABOUT that algorithm, per direct request.
//    Requirement 1 (run `pickHexSlot`/mark live track+stations BLOCKED for
//    nameplates, off-board blocks, compound terrain badges) needed no new
//    code: nameplates and compound terrain badges already route through
//    `claimHexSlot` (#72/#74/#87), and `hexBlockedSlots` already marks a
//    slot BLOCKED from live track/station occupancy (#70); off-board
//    blocks (`drawOffboardNameplate`) remain their own single
//    self-contained centered unit (#78c) that never competes for a slot
//    with anything else on its hex, so they were never a collision risk
//    to begin with and needed no change either.
//
//    Requirement 2 is the real change: every perimeter slot (1-12) sits at
//    a fixed 30-degree increment (`SLOT_ANGLE_DEG`, hand-derived from
//    `hexSlotDirection`'s own edge/corner angle math and verified against
//    all twelve). New `angularConflictSlots(claimedSlots)` flags any slot
//    within `MIN_SLOT_ANGULAR_SEPARATION_DEG` (120) of an already-claimed
//    slot on the SAME hex -- e.g. claiming Slot 10 (Bottom Point, 90 deg)
//    flags Slot 9 (Lower-Right corner, 30 deg, only 60 deg away) and Slot
//    11 (Lower-Left, 150 deg, 60 deg away) but leaves Slot 7 (Top Point,
//    270 deg, exactly opposite), Slot 1 (edge, 300 deg, 150 deg away), and
//    Slot 0 (center, no angle, always compatible) clear -- the task's own
//    worked example, reproduced exactly. `pickHexSlot` takes this as a new
//    optional `angularConflict` parameter, folded into its existing 3-tier
//    open/dead-edge search as an EXTRA soft-avoid layer tried first; if no
//    candidate can satisfy both real-collision-avoidance AND angular
//    separation at once, it degrades to the original (pre-#104) 4-tier
//    search, ignoring angular spacing -- a genuinely packed hex (New York/
//    G19, already at its structural limit with only two open corners and
//    four open edges before this pass) still gets a real, collision-
//    avoiding slot rather than none. `claimHexSlot` computes
//    `angularConflictSlots` from its own `alreadyClaimed` set and threads
//    it through automatically -- every existing call site (nameplates,
//    restriction badges, terrain-cost/compound badges, revenue badges)
//    picked this up with NO call-site changes.
//
//    VERIFICATION (Requirement 3), hand-traced against this system's own
//    documented facts rather than assumed: G19's layout (two live stub
//    edges leaving corners 9/12 and edges 2/3/5/6 open) is UNCHANGED by
//    this pass -- its four claims (icon+cost combined at slot 3, "NY"
//    badge at slot 12, revenue badge at slot 9) already consume every
//    angularly-compatible option, so the graceful degrade reproduces the
//    exact pre-#104 result, matching #71/#72/#76's own documented
//    resolution. Atlantic City (I19, real printed edges 2/3, town marker)
//    previously had its nameplate (slot 10, Bottom Point) and revenue
//    badge landing only 60 degrees apart at slot 9 (traced by hand through
//    `BADGE_SLOT_PREFERENCE`'s own tier-3 fallback) -- WITH this pass, the
//    badge now lands at slot 8 instead, exactly 120 degrees from the
//    nameplate, a genuine visible improvement of the kind this task asked
//    for. Off-board destinations (Requirement 3's third example) render
//    exactly as before, per this note's own Requirement 1 paragraph above.
//
// 105. **Per-Feature Slot Preferences Tuned; Claim Order Reordered to
//    Nameplate > Terrain Badge > Revenue Badge > Restriction Badge.** Four
//    related changes, per direct request, all still within #104's newly
//    opened-up scope (this pass is explicitly ABOUT the 13-slot placement
//    algorithm, not just its typography).
//
//    (a) `NAMEPLATE_SLOT_PREFERENCE`: now leads with center (slot 0), then
//    the top vertex (slot 7), then the bottom vertex (slot 10) -- was
//    Upper-Left (12) first, Bottom (10) second. Center is blocked on
//    nearly every real hex (see `hexBlockedSlots`), so this is a practical
//    no-op fallthrough to the top vertex except on a genuinely blank,
//    trackless named hex, where it now correctly centers the nameplate.
//
//    (b) `COMPLEX_HEX_TERRAIN_SLOT_PREFERENCE` (the compound terrain
//    icon/cost badge): now leads with (the request's own naming) "Vertex
//    2"/"Vertex 4" -- this system's slot 9 (Lower-Right) and slot 11
//    (Lower-Left) -- before falling through to the original SE-edge/
//    Bottom-Point pair (slots 3/10).
//
//    (c) `RESTRICTION_SLOT_PREFERENCE_DOUBLE_CITY`/`_OTHER` (the "B"/"NY"/
//    "OO" badges): UNIFIED to the same list, leading with "Vertex 5"/
//    "Vertex 1" (slots 12/8, matching what DoubleCity already preferred),
//    THEN every edge midpoint ("then check edges") -- reachable for the
//    first time because `drawRestrictionBadge` no longer restricts
//    `claimHexSlot`'s fallback pool to `CORNER_SLOTS` (that pool is now
//    unused, left defined per this file's own "don't delete superseded
//    constants" convention) and its own `badgeCenter` math is generalized
//    from the old corner-only `cornerAngleRad` formula to
//    `hexSlotDirection(slot)`, which already resolves the correct angle
//    for either a corner or an edge slot. The old archetype-driven split
//    (SingleCity/DoubleCity preferring opposite corners, to dodge each
//    other's DIFFERENT old nameplate position) is retired along with it --
//    now that nameplates lead with center/top/bottom instead of
//    Upper-Left (item a), that split no longer serves the collision it was
//    built to avoid.
//
//    (d) CLAIM/DRAW ORDER: the file's four Layer-4 slot-claiming passes
//    were physically reordered (nameplates -- both the landmark loop and
//    the gray/named-hex loop, plus the never-competing off-board nameplate
//    pass grouped alongside them -- now run FIRST, then the terrain-cost/
//    compound-badge pass, then the three revenue-badge loops, then the
//    restriction-badge loops LAST) to match the request's own explicit
//    "the order they should be claimed in is: nameplate > conjunct terrain
//    icon/cost > revenue badge > tile restriction marker" -- was nameplate
//    > restriction badge > terrain cost > revenue badge. Verified via a
//    line-count-preserving block move (extracted each pass's exact text by
//    line range, reassembled in the new order, spliced back in) rather
//    than freehand retyping, specifically to rule out any accidental
//    content loss or duplication across a ~670-line reorder. Since these
//    are also the file's real Layer-4 DRAW calls (`claimHexSlot`'s own
//    claim happens inline as each element renders), this changes their
//    on-canvas stacking order too, not just claim priority -- restriction
//    badges now paint on top in the rare case two Layer-4 elements
//    visually overlap, an accepted side effect of honoring the requested
//    claim order through the same code path that draws.
//
// 106. **Nine-Hex Placement Diagnostic (D6/F6/E11/H12/J14/A19/G19/F22/E23).**
//    Reported, hex by hex, against specific requested vertices/edges in the
//    user's own established numbering (Vertex N = slot N+7; Edge N = slot
//    N+1, both 0-indexed clockwise from the true top -- derived this pass
//    by walking `SLOT_ANGLE_DEG` and cross-checked against D6's own
//    pre-existing bug, see below). Two distinct root causes, both fixed:
//
//    (a) GENERIC BUG (`pickHexSlot`/`claimHexSlot`/`extendSlotPreference`,
//    fixes D6 and contributes to several others): `claimHexSlot` used to
//    pre-merge a caller's real, curated preference list with
//    `extendSlotPreference`'s "no real preference, last resort" fallback
//    tail into ONE combined list before calling `pickHexSlot`, whose
//    dead-edge tiers then scanned that WHOLE combined list -- so a
//    low-priority fallback-tail slot that merely happened to sit next to a
//    permanently dead edge could leapfrog a genuinely open, actually-
//    preferred PRIMARY-list slot with no dead-edge adjacency of its own.
//    Concretely: D6 (blank, unlaid, nothing blocking its real preference)
//    still rendered its terrain-cost badge at Edge 5/slot6 instead of the
//    fully-open Vertex 3/slot10, because slot6 happened to sit next to D6's
//    one dead edge while slot10 didn't. Fixed by splitting the tiered
//    search into a new `pickFromCandidates` helper, run once against the
//    caller's real preference list to exhaustion, and only THEN against the
//    fallback tail as a separate, later attempt -- the fallback tail can no
//    longer outrank an available primary-preference slot, dead-edge-
//    adjacent or not. Hand-traced against D6 (now correctly resolves to
//    slot10) and re-verified this doesn't change any already-documented
//    #104 result (G19/Atlantic City) where the caller's own primary list
//    already contained the winning slot.
//
//    (b) PER-HEX EXPLICIT OVERRIDES (`HEX_SLOT_OVERRIDE`, new -- F6, A19,
//    H12, G19, F22, E23): several requests asked for one specific claim
//    pass on one specific hex to land on a canonical 18xx.games vertex/edge
//    that this system's board-wide generic preference lists don't (and
//    shouldn't, since changing them would ripple into every OTHER hex
//    sharing that pass) produce on their own. `HEX_SLOT_OVERRIDE` is a new
//    `"q,r"`-keyed table consulted via `withSlotOverride`, which PREPENDS
//    the requested slot onto that one pass's own normal preference list for
//    that one hex, rather than replacing it -- so an override still runs
//    through every one of `claimHexSlot`'s real safety checks (blocked/
//    dead-edge/angular-conflict/already-claimed) and gracefully falls back
//    to the pass's own real order if the requested slot turns out to be
//    genuinely occupied by real printed track. Every override in the table
//    was HAND-VERIFIED against the hex's actual real live edges before being
//    added (see the table's own doc comment for the full per-hex trace);
//    two requests (G19's revenue badge at Vertex 1, Boston/E23's at Vertex
//    0 and its nameplate at Vertex 3) turned out to be genuinely blocked by
//    real printed track and degrade to the nearest open alternative instead
//    -- the override is kept anyway as accurate documentation and because
//    the degrade is a harmless no-op, not a wrong claim. A companion table,
//    `HEX_SLOT_RESERVE`, handles the one case (Boston/E23) where an EARLIER
//    pass's own graceful fallback would otherwise claim the one slot a
//    LATER pass has an explicit, achievable override on (its restriction
//    badge's Vertex 5) -- it filters that one reserved slot out of every
//    other pass's candidate list on that hex, so the later pass's request
//    isn't accidentally starved by going second.
//
//    (c) TWO NON-SLOT FIXES, requested directly rather than via placement:
//    the Erie/E11 reserved station marker's fixed neutral-margin point
//    (previously straight down from center, shared by all four
//    `YELLOW_OO_HEXES`) is redirected to Vertex 2/slot9 for E11 SPECIFICALLY
//    (same `0.46 * hexSize` magnitude, new direction via `hexSlotDirection`
//    -- the other three OO hexes were never reported and are unchanged);
//    and Washington/J14's `NAMED_HEX_LABELS` entry is reverted from
//    "Washington, D.C." (#47's own explicit request) back to the bare
//    "Washington", per this pass's own explicit instruction to drop "D.C."
//    outright rather than relocate the nameplate.
//
//    NOT changed: the closing observation that non-nameplate offset
//    magnitudes (`size * 0.44` for revenue badges, `apothem * 0.7` for
//    restriction badges, `hexSize * 0.58` for terrain-cost points) might be
//    "simply too large" was evaluated but not acted on here -- every
//    collision this pass traced back to a SLOT choice (wrong corner/edge),
//    not a magnitude bleeding into a neighboring hex or this hex's own
//    track at the correct slot; shrinking these board-wide would touch
//    every hex on the map for a problem that, on inspection, wasn't a
//    magnitude problem. Left as an open question if collisions persist
//    after this pass's slot-level fixes.
//
// 107. **Revenue Badge Offset Reduced.** Reported directly, board-wide (not
//    tied to any one hex): revenue badges sit far enough out toward the hex
//    boundary to interfere with other elements. `drawValueBadge`'s
//    `badgeCenter` magnitude -- `size * 0.44` along whichever slot
//    `hexSlotDirection` resolved, applied uniformly to corner AND edge
//    slots alike -- reduced to `size * 0.38`, a real, board-wide pullback
//    toward hex center for every revenue badge on the map, not a per-hex
//    override. Chosen to stay a comfortable margin clear of the
//    `size * 0.22`-radius station circle at hex center for any realistic
//    badge size (this file's own text-driven `badgeRadiusForLabel` keeps
//    even a 3-digit value well under `size * 0.16`) while still pulling the
//    badge meaningfully closer to center than before. This is the
//    magnitude question #106's own closing note left open, now acted on
//    directly per this request rather than left as a maybe.
//
// 108. **Revenue Badge Offset Increased Past The Original Value.** Direct
//    follow-up: #107's `0.38` (already a real, verified board-wide change)
//    was reported as no perceptible difference, and the request was to
//    push the badge FURTHER from center than it originally was -- not
//    merely undo #107 back to the pre-#107 `0.44`. Raised to `size * 0.55`,
//    re-checked against both boundary shapes a badge can sit at (an EDGE
//    slot's boundary is the `apothem`, `size * 0.866`; a CORNER slot's is
//    the full `size`): `0.55` plus this file's own documented worst-case
//    badge radius (`size * 0.16`) reaches `size * 0.71` at most, clearing
//    even the tighter edge-slot boundary by `size * 0.156`, so the badge
//    stays fully on-hex at this larger magnitude at every one of the eight
//    slots `BADGE_SLOT_PREFERENCE` can resolve to.
//
// 109. **Revenue Badge Offset Increased Again, To `0.65`.** Direct
//    follow-up to #108. Same two-boundary check, numbers updated: at a
//    CORNER slot (boundary = full `size`), `0.65` plus the documented
//    worst-case badge radius (`size * 0.16`) reaches `size * 0.81`, still
//    `size * 0.19` clear. At an EDGE slot (boundary = `apothem`, `size *
//    0.866`), that same worst-case reach leaves only `size * 0.056` of
//    clearance -- a real narrowing from #108's `0.156`, flagged here rather
//    than silently accepted: a wide printed value landing at an edge slot
//    is now close enough to the boundary that it could start to look
//    visually crowded there, though it does not mathematically cross it at
//    today's badge sizing. Implemented as requested.
//
// 110. **Vertex/Edge Convention Confirmed; Six More Hexes Placed; G19
//    Terrain Badge Bug Found And Fixed.** The user supplied their own
//    explicit numbering this pass ("Vertex 0 is the top point... Edge 0 is
//    the edge immediately to the right of Vertex 0... clockwise... Edge 5
//    looping back to Edge 0") -- cross-checked against this system's own
//    `SLOT_ANGLE_DEG`-derived convention (Vertex N = slot N+7, Edge N =
//    slot N+1, both already in use since design note #106's own D6
//    diagnosis) and it matches exactly, confirming every prior pass's
//    translation was correct.
//
//    CORRECTION (found while placing G19's terrain badge): a prior pass
//    concluded New York has no terrain badge at all, checking only
//    `LANDMARK_HEXES` (which indeed carries no `type` field). Missed that
//    `STATIC_BOARD_HEXES` ALSO carries its own separate `q:6,r:6` entry --
//    `{ type: "River", printedColor: "Yellow" }`, added by design note #71
//    specifically to give New York its real $80 water terrain cost -- so
//    the terrain-cost pass DOES process G19. Added the missing `terrain: 9`
//    override and a matching `HEX_SLOT_RESERVE` entry (terrain's claim at
//    Vertex 2 would otherwise leave the revenue badge's own fallback search
//    free to land on Vertex 5, stealing the restriction badge's slot).
//
//    NEW HEXES: J14/Washington (nameplate -> Vertex 0, terrain -> Vertex 2,
//    both fully open on this blank hex) and I15/Baltimore (nameplate ->
//    Vertex 0, open; revenue badge's requested Vertex 2 HAND-VERIFIED
//    blocked by Baltimore's own real edge-0 track, degrades to Edge 2;
//    restriction badge's requested Edge 4 HAND-VERIFIED open, achieved).
//
//    E23/Boston's revenue badge REQUEST CHANGED from Vertex 0 (already
//    known blocked, per #106) to Vertex 5 (open) -- `HEX_SLOT_OVERRIDE`
//    updated, and `HEX_SLOT_RESERVE`'s Boston entry REPOINTED from
//    `restriction` to `revenue` accordingly, since revenue is now the pass
//    with the achievable claim on that slot and the nameplate (running
//    earlier) is the one that needs to be steered around it. The "B"
//    restriction badge has no explicit request this round and simply takes
//    its own next-best open slot.
//
//    A19's revenue badge request (Edge 1) matches #106's own
//    already-corrected placement there exactly -- independent confirmation
//    that fix was right; no change needed. F22's nameplate request (Vertex
//    0) likewise already matches its existing override -- no change.
//
// 111. **Explicit Override System Fixed -- Real Bug, Not A Sync Issue.**
//    Reported with a screenshot (J14/Washington): the nameplate rendered at
//    Vertex 1, not the override's Vertex 0; the terrain badge rendered at
//    Vertex 4, not Vertex 2. HAND-VERIFIED by computing Washington's real
//    dead edges (the same coordinate-extraction method design note #106
//    used for D6): J14 has exactly ONE dead edge, its own east
//    board-boundary edge, whose two guard corners are Vertex 1/slot8 AND
//    Vertex 2/slot9 -- BOTH of the two corners this hex's reports actually
//    landed on or got displaced from. Root cause: `withSlotOverride`
//    (#106) prepended the override slot onto the pass's full preference
//    list and ran the COMBINED list through the normal tiered search --
//    whose tier 1/2 favor ANY dead-edge-adjacent, open slot over a merely-
//    open one, REGARDLESS of list position. Vertex 0/slot7 (the override,
//    genuinely open, first in the list) isn't dead-edge-adjacent here, so
//    tier 1 skipped past it and matched Vertex 1/slot8 instead, purely
//    because slot8 happens to sit next to that one dead edge -- the exact
//    D6 bug from #106, reproduced one level up (inside a single already-
//    combined list, not the primary-list/fallback-tail split #106 fixed).
//    Once the nameplate wrongly landed on slot8, its own angular-conflict
//    avoidance then pushed the terrain badge off Vertex 2/slot9 (also
//    dead-edge-adjacent, and only 60 degrees from slot8) onto Vertex
//    4/slot11 instead -- a real, mechanically-explained cascade, not
//    randomness.
//
//    FIXED by giving an explicit override its own resolution path, entirely
//    separate from the tiered preference search: new `resolveSlotOverride`
//    (looks up `HEX_SLOT_OVERRIDE`, returns `undefined` if the slot is
//    `HEX_SLOT_RESERVE`d for a different pass) and `claimHexSlotPreferring`
//    (tries that slot directly -- blocked/already-claimed check ONLY, no
//    dead-edge tiering, no angular-conflict soft-avoidance either, since an
//    explicit request should win a mere tiebreak heuristic -- and falls
//    through to the ordinary `claimHexSlot` tiered search over the pass's
//    UNMODIFIED preference list only if the override is missing or
//    genuinely unusable). `withSlotOverride` itself is superseded and no
//    longer called anywhere (kept defined, unused, per this file's own
//    convention). Every hex/pass in `HEX_SLOT_OVERRIDE` re-verified by hand
//    against this new resolution path -- every previously-documented
//    "gracefully degrades due to real track" case (G19/Vertex 1, I15's
//    revenue badge, E23's nameplate) still degrades the same way, since
//    only the OVERRIDE side changed; the ordinary tiered fallback search
//    itself is untouched.
//
// 112. **H18's Restriction Badge -- Same Dead-Edge Bug, No Override
//    Involved.** Reported directly, with the correct root-cause guess
//    attached: H18's "OO" restriction badge wasn't at Vertex 5 like the
//    other three `YELLOW_OO_HEXES`. HAND-VERIFIED (same coordinate-
//    extraction method as #106/#111): H18 has exactly one dead edge (its
//    own east board-boundary edge), and that edge's two guard corners are
//    Vertex 1/slot8 and Vertex 2/slot9. `RESTRICTION_SLOT_PREFERENCE_
//    DOUBLE_CITY` leads with Vertex 5/slot12, genuinely open here (H18 has
//    no real printed track at all) -- but #111's diagnosis applies
//    unmodified: tier 1's "prefer a dead-edge-adjacent open slot" scan
//    matched Vertex 1 (later in the list, but dead-edge-adjacent) before
//    ever confirming Vertex 5 was already a perfectly good, if merely
//    "just open," answer. This is NOT the override system #111 fixed --
//    H18 had no `HEX_SLOT_OVERRIDE` entry at all, so this is the same
//    root-cause tier behavior surfacing in the PLAIN, non-override
//    preference-list path instead. Fixed the same way #111 fixes an
//    override: added `"5,7": { restriction: 12 }` to `HEX_SLOT_OVERRIDE`,
//    which now resolves through `claimHexSlotPreferring`'s direct
//    blocked/claimed check, bypassing the dead-edge tier entirely.
//    CONFIRMED the other three OO hexes (E5, D10, E11) are unaffected --
//    all three are fully interior with zero dead edges, so their own tier
//    1 never matches anything and they already fall straight to Vertex 5
//    via tier 3, exactly as expected, no override needed for them.
//
// 113. **G19 Revenue Badge Force-Placed At Vertex 1, Collisions And All.**
//    Direct request: "I want to see how it looks there, I don't care what
//    it overlaps" -- a genuinely different ask from every prior placement
//    request, which all wanted the SAFEST achievable slot. New
//    `HEX_SLOT_FORCE` table + `claimHexSlotForced`, kept deliberately
//    separate from `HEX_SLOT_OVERRIDE`/`resolveSlotOverride`: a force skips
//    every collision check this file has (real printed track, already-
//    claimed-on-this-hex, angular crowding) entirely -- it always wins. New
//    York's revenue badge now sits at Vertex 1/slot8, directly on top of
//    its own real NE track stub, exactly as asked. The claim is still
//    RECORDED in `claimedHexSlots`, so the terrain/restriction passes on
//    the same hex still steer clear of slot8 themselves (their own
//    collision-avoidance isn't what's being disabled here) -- only the
//    revenue badge's own check is skipped. `HEX_SLOT_OVERRIDE`'s existing
//    `"6,6": { revenue: 8, ... }` entry is now moot for revenue specifically
//    (the force checked first) but left in place, both as an accurate
//    record of the original request and because it's a harmless no-op.
//
// 114. **G19: Vertex 1 Confirmed Bad, Moved To Edge 4/Edge 5 Instead.**
//    Direct follow-up after seeing #113's forced result ("I see it is a
//    problem there"): revenue badge -> Edge 4/slot5, restriction badge
//    ("NY") -> Edge 5/slot6. HAND-VERIFIED against New York's real
//    `{ edges: [1, 4] }`: neither Edge 4's guard edge (internal edge 3) nor
//    Edge 5's (internal edge 2) is one of those two live edges, so both
//    resolve directly through the ordinary `HEX_SLOT_OVERRIDE` path with no
//    degrade needed -- unlike Vertex 1 (blocked) and Vertex 5 (open, but
//    needed protecting from an earlier pass's fallback via
//    `HEX_SLOT_RESERVE`) before them. `HEX_SLOT_FORCE`'s G19 entry removed
//    (no longer forcing anything -- the new slots are genuinely
//    collision-free) and `HEX_SLOT_RESERVE`'s G19 entry removed too
//    (nothing competes for Edge 4/Edge 5 the way things once competed for
//    Vertex 5) -- both tables' machinery stays in place for future use, just
//    with G19 no longer needing either.
//
// 115. **E23/Boston's Nameplate Force-Placed At Vertex 3.** Reported with a
//    suspicion attached: that the nameplate's inability to reach Vertex 3
//    (degrading to Vertex 4 since design note #106) was the same dead-edge
//    tier leapfrog bug #111/#112 fixed elsewhere. CHECKED, not assumed: it
//    is not -- Vertex 3/slot10's two guard edges are internal edges 4 and
//    5, and edge 5 IS one of Boston's own two real live edges
//    (`LANDMARK_TRACKS["Boston"]`'s `{ edges: [1, 5] }`), so this was
//    always a genuine track collision, correctly identified as such by
//    `HEX_SLOT_OVERRIDE`'s own graceful degrade the whole time -- not a
//    bug to fix. Direct follow-up request accepted the collision anyway
//    ("move it to Vertex 3 even if it collides with the track"), so
//    `HEX_SLOT_FORCE` (design note #113's mechanism, built for exactly
//    this) gained an E23 entry: `{ nameplate: 10 }`. Boston's nameplate now
//    renders at Vertex 3 unconditionally, overlapping its own SE track
//    stub as requested.

// 116. **Reserved Station Markers Heavily Grayed/Transparent.** Direct
//    request: "make sure that the station reservation markers are heavily
//    grayed out, or transparent, or something similar, to show players
//    that the station is reserved but not currently blocking routes."
//    `drawStationTokenMarker`'s `muted` (reserved/unfloated) path is
//    REVERSED from #46/#48's original solid-opaque-navy-plus-full-brand-ring
//    treatment: the fill is now a neutral mid-gray (`#9CA3AF`, not the
//    company's own color) AND the whole badge (fill, ring stroke, ticker
//    text, halo) is drawn at reduced `globalAlpha` (0.45) via a `ctx.save()`
//    / conditional-alpha / `ctx.restore()` wrap -- combining "grayed out"
//    and "transparent" per the request's own "or something similar."
//    Floated (real, non-muted) badges are completely unchanged: full
//    opacity, full company color, unmuted brand-color ring.
//
// 117. **Tooltip `(Stations: N)` Suffix.** Direct request: "let's add to
//    the tooltip display a (Stations: ) when a tile has stations on it."
//    `N` comes from `archetypeForHex`, cross-referenced against
//    `hexmap.rs`'s real `execute_place_station_token` "tokenable city" rule
//    (module doc comment #27: only `MajorCityHub`/`DoubleCityHub`/
//    `BostonHub`/`NewYorkHub` terrains can ever hold a station token,
//    `SmallTown`/`DoubleTown` explicitly excluded) so this is the actual
//    real station capacity, not a guess from icon shape:
//    `"SingleCity"` -> 1, `"DoubleCity"` -> 2, `"SingleTown"`/`"DoubleTown"`/
//    `"Plain"` -> 0 (no suffix printed at all). Appended in
//    `describeHexWithValue` last, after the existing `(Value: $X)` and
//    `(Terrain Cost: $Y)` suffixes, matching that function's established
//    left-to-right ordering (name, value, cost, capacity).
// 118. **46-Tile Tray Catalog Sync (backend Audit G-5).** The backend
//    catalog stopped using this engine's synthetic sequential `tile_id`s
//    and now keys every entry on the tile's REAL physical 1830 tray number,
//    across the complete 46-tile roster. `GetLegalTilePlacements` and
//    `GetMapGrid` both return those tray numbers now. Four parts:
//
//    (a) `TILE_CATALOG` rewritten wholesale -- 20 old entries out, 46 real
//    ones in. See that constant's own doc comment for the full old-id ->
//    tray-number table and, more importantly, for why this could not be a
//    partial patch: the two id spaces OVERLAP with different meanings (old
//    internal 16/18/19/20/23/24 were "B"/"NY"/"OO" hub artwork; real tray
//    #16/#18/#19/#20/#23/#24 are ordinary green plain track), so a stale
//    entry would resolve to confidently WRONG artwork rather than to the
//    honest unknown-tile placeholder. The invented terrain tiles (old ids
//    4, 5, 12) and invented green filler (old 11, 13) are gone -- terrain
//    is now charged per HEX, see `TERRAIN_BUILD_COST_LABEL`. Note real tray
//    #4 exists and is a single-town straight; it is NOT the deleted river
//    tile that used to occupy id 4.
//
//    (b) Three real rendering bugs the new geometry exposed, all fixed in
//    `drawTrackPath` (each has its own inline note): `cityGroups` is now
//    tested BEFORE the 2-live-edge shortcut, because #59 ("OO" Green) is a
//    two-city tile with exactly two live edges and was being drawn as a
//    single through-route joining them; `cityGroups` edges are now rotated
//    into post-rotation edge space before being intersected with the live
//    set, which they never were, so rotated NY/OO tiles were dropping most
//    of their own track; and the station/dit marker block is hoisted out of
//    the 3+-edge branch and keyed purely on TERRAIN, because #57 (the
//    yellow city tile every plain-city hex starts from) has two live edges
//    and was drawing no station at all, while the five double-town tiles
//    have four live edges each and were drawing no dits.
//
//    (c) Unknown-`tile_id` fallback upgraded from a bare red "#N?" to
//    `drawUnknownTilePlaceholder`'s neutral dashed provisional artwork, in
//    both render paths. All 46 real tiles are mapped, so this is now purely
//    a future-drift safety net -- but it is one the player can still read
//    and act on, which matters because `TileSelectionPopup` offers whatever
//    the contract returns, unfiltered.
//
//    (d) A dev-only drift tripwire next to `TILE_CATALOG_BY_ID` warns if
//    the mirror's length or unique-id count ever stops matching
//    `TILE_CATALOG_SIZE`, since a duplicated id silently collapses inside
//    the `Map` and shadows an entry.
// 119. **Discrete Double-Town Paths.** The five DoubleTown tiles (#1, #2,
//    #55, #56, #69) now render their two real, separate town routes instead
//    of one generic fan-to-centre, and place each dit ON its own route.
//
//    The problem was informational, not cosmetic. Each of these tiles has
//    four live edges paired into two independent two-edge routes, and
//    `connections` is a flat union that cannot say which edge pairs with
//    which. It is not merely lossy in principle: #1 and #55 share the
//    identical mask `0b01_1011` while pairing {0,4}+{1,3} versus {0,3}+{1,4},
//    and #2 and #56 share `0b00_1111` while pairing {0,3}+{1,2} versus
//    {0,2}+{1,3}. No function of the mask can distinguish those, so all four
//    drew as the same four-way junction with two dits floated at fixed
//    offsets -- wrong topology and wrong dit placement on all five.
//
//    The data already existed on the backend: `hexmap::TILE_CATALOG` has
//    carried a seventh edge-pair field since Audit G-9 and `pathfinding.rs`
//    routes on it. What was missing was a way for a client to see it, so
//    this pass added `paths` to `msg::MapTileEntry` (resolved contract-side
//    through the new `hexmap::effective_base_tile_paths`, which keeps the
//    stored-list-then-catalog fallback `effective_tile_paths` already used,
//    minus the rotation -- this response states edges pre-rotation and
//    reports `orientation` separately, matching `connections`).
//
//    Two sources, deliberately, resolved by `pathsForTile`: the query row
//    wins for a laid tile, and this file's `TILE_CATALOG` mirror is the
//    fallback. The mirror is not redundancy for its own sake --
//    `TilePreviewThumbnail` renders tiles that are not on the board yet and
//    has no query row by construction, so without a mirror copy a previewed
//    double-town would draw differently from the same tile once laid. The
//    same fallback covers a contract deployed before `MapTileEntry.paths`
//    existed, which simply omits the key.
//
//    Scope is deliberately narrow: the branch is gated on BOTH
//    `terrain === "DoubleTown"` and paths actually being present, so only
//    those five tiles can reach it. Multi-edge city and plain tiles carry
//    path lists in the Rust catalog too, but their existing branches already
//    render them correctly, so they are untouched and the mirror does not
//    duplicate their paths.
//
//    One honest deviation, noted at the branch: each route is drawn through
//    its own `twoNodePositions` node rather than through hex centre, so the
//    two dits sit on their own track instead of colliding at the middle.
//    Real #55 draws two straights that genuinely cross there. The topology
//    -- which edge connects to which -- is exactly what the catalog
//    declares; only the curvature is a presentation choice.
//    SUPERSEDED by design note #121: that deviation was not as small as
//    this note claimed. Bending #55's two straights around offset nodes
//    turned its X into a pair of visibly bowed arms, and warped #56 badly
//    enough to be hard to read. The generalized offset is gone; see #121.
// 120. **Tile Picker Opens Without A Chain.** Reported as "the tile picker
//    refuses to open at all" when running `npm start` with no backend, no
//    exception thrown, and the "[TileSelection] hex clicked" log still
//    printing normally.
//
//    NOT caused by design note #119, despite arriving right after it. That
//    pass touched the catalog mirror, `rotatePaths`/`pathsForTile`/
//    `assignTownNodes` and one `drawTrackPath` branch -- all canvas
//    rendering, none of it in the click pipeline, and `pathsForTile`
//    returning `undefined` is its designed fallback, not a failure. Nothing
//    in the picker flow queries `paths` at all: those ride on `GetMapGrid`
//    (board data), while the picker runs `GetLegalTilePlacements`, which
//    #119 never touched. No promise was left pending either.
//
//    The real cause was long-standing and structural. The click handler's
//    guard tested all four interceptor props at once --
//    `if (!queryClient || !contractAddress || gameId === undefined ||
//    protocolId === undefined) return;` -- and those props go missing for
//    two unrelated reasons. Route-select mode omits them ON PURPOSE, to keep
//    a route-point click from also popping the picker (design note #7,
//    App.tsx design note #11). Running without a wallet or node leaves ONLY
//    `queryClient` undefined, since the other three are constants. Both hit
//    the same `return`, so `onHexClickQuery` never fired, App.tsx's
//    `hexClickQuery` stayed `null`, and its `status === "success"` gate
//    never rendered the popup. The picker had no offline path whatsoever --
//    it wasn't hanging or failing, it had decided there was nothing to do.
//
//    Fix: split the guard on that exact distinction. Missing hex identity
//    (`contractAddress`/`gameId`/`protocolId`) still returns silently, so
//    route-select mode is untouched. Missing `queryClient` alone now falls
//    back to `localCatalogPlacements`, and reports `status: "offline"`.
//
//    That fallback filters by ERA AND NOTHING ELSE, and deliberately does
//    not reimplement `hexmap::legal_tile_placements` -- no connectivity, no
//    reservations, no colour-step, no tray depletion. Hence a distinct
//    status rather than a flag on `"success"`: a separate variant makes the
//    type checker point at every consumer that must decide what to do with
//    unvalidated data, where a flag lets a consumer treat it as
//    authoritative just by not knowing to look. `TileSelectionPopup` renders
//    it under an explicit banner and refuses to dispatch from it.
// 121. **Canonical Double-Town Artwork, Drawn Explicitly.** Reported: the
//    generalized double-town renderer from design note #119 produced
//    non-canonical track. #55 -- which is simply two straights crossing in
//    an X -- came out with both arms visibly bowed, and #56's two gentle
//    curves were warped enough to be hard to read.
//
//    The cause was a priority inversion in #119. That pass routed each town's
//    track through its own offset node so the two dits could not collide at
//    hex centre. In other words it moved the TRACK to make room for the
//    MARKERS. For the two tiles whose whole character is a straight line,
//    that is exactly backwards: a straight that bows is no longer the tile.
//
//    Fixed by abandoning the general algorithm. There are exactly five
//    double-town tiles in all of 1830 and there will never be a sixth, so
//    `DOUBLE_TOWN_ROUTES` now states each one's artwork explicitly, keyed on
//    `tileId`. `drawDoubleTownRoute` draws each declared edge pair in its
//    natural shape and reports the point halfway along what it actually
//    drew, so the dit follows the track instead of the track following the
//    dit:
//      - opposite edges take a literal `lineTo`, not a Bezier that happens
//        to look straight, so #55's X cannot bow by even a pixel;
//      - everything else takes ONE cubic Bezier with control points on each
//        endpoint's own inward normal at the file's standard `0.3` reach,
//        which yields a tight corner for a 60-degree pair and a shallow bow
//        for a 120-degree pair with no per-shape fudging.
//
//    Only #55 needs a marker rule of its own, because it is the only tile
//    whose routes are BOTH straights and therefore share a midpoint at dead
//    centre. Its two dits slide out along their own arms toward adjacent
//    edges -- moving the markers, never the geometry.
//
//    Consequence worth knowing: this renderer no longer reads
//    `msg::MapTileEntry::paths` for artwork, and #119's `rotatePaths`/
//    `pathsForTile` are deleted as dead. The contract still sends the field
//    and `TileCatalogEntry.paths` still mirrors it -- the mirror now feeds a
//    dev-mode tripwire that cross-checks `DOUBLE_TOWN_ROUTES` against the
//    catalog, so the explicit table cannot silently drift from the data.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PILL_SLOT_SPACING,
  TILE_GRAPHICS_CATALOG,
  tileArtworkPaths,
  tileCityAnchors,
  tileCitySlotPoints,
  tileMarkerPoints,
} from "./TileGraphics";
// Monolith split, Phase 1. Imported under their own names because this file's
// own code refers to them unqualified throughout; the matching
// `export ... from` re-export further down keeps them on this module's public
// surface for `App.tsx` / `TileSelectionPopup.tsx`. A re-export creates no
// local binding, so the two statements do not collide.
//
// MUST live here, at the top, not beside that re-export: ESLint's
// `import/first` requires every `import` to precede all other statements, and
// this file's first statement is ~3,300 lines below its own header comment,
// which makes "next to the thing it relates to" and "at the top" look like
// the same place when they are not.
import {
  TILE_CATALOG,
  TILE_CATALOG_BY_ID,
  type TerrainType,
  type TileCatalogEntry,
  type TileColorTier,
} from "./hexTileCatalog";

/* ------------------------------------------------------------------ */
/* Contract data mirrors -- see design note #2                        */
/* ------------------------------------------------------------------ */

/** Mirrors `msg.rs`'s `MapTileEntry` exactly -- one laid hex tile. */
export interface MapTileEntry {
  q: number;
  r: number;
  tile_id: number;
  orientation: number;
  /** This tile's DISCRETE track segments as BASE (pre-rotation) edge pairs
   *  -- `msg::MapTileEntry::paths`, resolved contract-side through
   *  `hexmap::effective_base_tile_paths` (design note #119).
   *
   *  Each `[a, b]` is one continuous run of track between edges `a` and
   *  `b`; `a === b` is a terminal spur that enters at `a` and dead-ends.
   *  Apply `orientation` yourself, the same as for a catalog entry's
   *  `connections` -- `rotatePaths` below does it.
   *
   *  OPTIONAL on purpose, and the optionality is not decorative: this
   *  component renders against whatever a deployed contract actually
   *  returns, and a contract built before this field existed simply omits
   *  the key. `pathsForTile` treats `undefined` and `[]` identically and
   *  falls back to the local `TILE_CATALOG` mirror, so an older chain
   *  renders exactly as it did before rather than throwing. */
  paths?: ReadonlyArray<readonly [number, number]> | null;
  /** Design note #132: THIS TILE'S PRINTED REVENUE, straight off the chain
   *  -- `msg::MapTileEntry::revenue` (`hexmap::tile_base_value`, Audit
   *  G-11). The single authority for what a stop on this hex pays.
   *
   *  Typed `string | number` because the backend field is `Uint128`, and
   *  cosmwasm-std serialises `Uint128` as a JSON **string** (`"90"`), not a
   *  number -- it has to, since a `u128` overflows an IEEE-754 double past
   *  2^53. Reading this as `entry.revenue` and expecting arithmetic to work
   *  is the trap; `chainTileRevenue` below parses it in exactly one place.
   *  `number` is accepted too so a hand-built fixture or a future
   *  narrower-typed field needs no change here.
   *
   *  OPTIONAL for the same backwards-compatibility reason as `paths` above:
   *  a contract built before Audit G-11 simply omits the key, and
   *  `chainTileRevenue` returns `undefined` so the caller falls back to the
   *  old terrain bucket rather than printing `NaN` or `$0`.
   *
   *  NOT to be re-derived from `terrain`. That is what this replaces, and
   *  it was wrong for most city tiles: `terrainBaseValue` is a flat
   *  per-bucket lookup, but real 1830 prints revenue on the TILE. #62 and
   *  #64 are both two-city brown artwork and print different figures; the
   *  whole Green/Brown city ladder (#14/#15 at $30, #63 at $40) collapsed
   *  to one bucket value under the old model. */
  revenue?: string | number | null;
  landmark: string | null;
}

/** Design note #132: parses `MapTileEntry.revenue` -- the chain's own
 *  `Uint128`, which arrives as a JSON string -- into a number, or
 *  `undefined` if this contract predates the field.
 *
 *  `undefined` and `0` are DIFFERENT answers and callers must not conflate
 *  them: `0` is a real figure (plain connector track earns nothing, and the
 *  badge should be suppressed), `undefined` means "this chain never told
 *  us" (fall back to the terrain bucket). */
function chainTileRevenue(tile: MapTileEntry): number | undefined {
  const raw = tile.revenue;
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = typeof raw === "number" ? raw : Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : undefined;
}

/** Mirrors `msg.rs`'s `MapGridResponse` exactly -- `QueryMsg::GetMapGrid`'s
 *  response shape. */
export interface MapGridResponse {
  game_id: number;
  tiles: MapTileEntry[];
}

/** Structural shape this component needs from a chain query client --
 *  matches both `CosmWasmClient` and `SigningCosmWasmClient` from
 *  `@cosmjs/cosmwasm-stargate` without importing that package into this
 *  otherwise wallet-agnostic file (see design note #7). Any object with a
 *  compatible `queryContractSmart` (App.tsx's already-connected
 *  `SigningCosmWasmClient` included) satisfies this. */
export interface QueryCapableClient {
  queryContractSmart(contractAddress: string, queryMsg: Record<string, unknown>): Promise<unknown>;
}

/** Station Tokens (design note #36): a hand-kept SUBSET mirror of
 *  `utils/gameState.ts`'s `PublicCompanyState` -- only the fields this
 *  component's Station Token rendering pass actually needs, re-declared
 *  locally rather than imported (see design note #36 for why). Every
 *  field here is a direct, same-name, same-shape copy of its
 *  `PublicCompanyState`/`msg.rs::PublicCompanyState` counterpart. */
export interface StationTokenCompany {
  company_id: number;
  ticker: string;
  is_floated: boolean;
  /** `(q, r)` pairs, home hex first (if granted) -- mirrors
   *  `PublicCompanyState.station_token_hexes` exactly. */
  station_token_hexes: Array<[number, number]>;
  /** Design note #134: the SAME tokens as `station_token_hexes`, but as
   *  `(q, r, city_index)` -- mirrors `PublicCompanyState.station_tokens`
   *  (backend Audit G-12).
   *
   *  A hex is not a city. New York (#54/#62) and every OO tile
   *  (#59/#64-#68) carry two separate cities on one hex, and `(q, r)` alone
   *  cannot say which one holds this company's token -- which is why
   *  `stationMarkerPoint` used to guess from the hex label and drop tokens
   *  on the wrong half of a two-city tile.
   *
   *  OPTIONAL: a contract predating G-12 omits it, and `tokenCityIndex`
   *  below falls back to the old heuristic rather than throwing. An empty
   *  array alongside a non-empty `station_token_hexes` means "this chain
   *  doesn't know", never "no tokens". */
  station_tokens?: Array<[number, number, number]> | null;
}

/** Which city on `(q, r)` holds `company`'s token -- design note #134.
 *
 *  Prefers the chain's own answer. Returns `undefined` when the chain has
 *  not told us, which is a DIFFERENT answer from `0` and must stay
 *  distinguishable: the caller falls back to `stationMarkerPoint`'s legacy
 *  per-hex heuristic rather than asserting city 0 and confidently drawing a
 *  token in the wrong station. */
function tokenCityIndex(
  company: StationTokenCompany,
  q: number,
  r: number,
): number | undefined {
  const entry = company.station_tokens?.find(([tq, tr]) => tq === q && tr === r);
  return entry ? entry[2] : undefined;
}

/** Station Tokens (design note #36; REASSIGNED by design note #44's house
 *  rule): a local mirror of `hexmap::CORPORATION_HOME_HEX` -- all eight core
 *  corporations' preprinted home hex, sourced from this same file's own
 *  `LANDMARK_HEXES`/`GRAY_HEXES`/`YELLOW_OO_HEXES` entries above exactly the
 *  way the backend constant's own doc comment describes deriving it. As of
 *  design note #44 (mirroring `hexmap.rs` module doc comment #25's backend
 *  house rule), NYC (company_id 2) is reassigned to Albany (E19) and NNH
 *  (company_id 7, "NYNH") -- previously omitted for having no assigned home
 *  -- takes over the New York (G19) hex NYC vacated. This is a deliberate
 *  departure from real 1830 (where NYC's home is G19), requested three
 *  times, explicitly, by the same requester who owns this custom board. */
const STATION_HOME_HEXES: ReadonlyArray<{
  companyId: number;
  q: number;
  r: number;
  label: string;
}> = [
  { companyId: 1, q: 2, r: 7, label: "H12" }, // PRR -> Altoona
  { companyId: 2, q: 7, r: 4, label: "E19" }, // NYC -> Albany (house rule, design note #44)
  { companyId: 3, q: 9, r: 0, label: "A19" }, // CPR -> Montreal
  { companyId: 4, q: 3, r: 8, label: "I15" }, // B&O -> Baltimore
  { companyId: 5, q: 0, r: 5, label: "F6" }, // C&O -> Cleveland
  { companyId: 6, q: 3, r: 4, label: "E11" }, // ERIE -> Dunkirk & Buffalo (shared OO hex)
  { companyId: 7, q: 6, r: 6, label: "G19" }, // NNH ("NYNH") -> New York (house rule, design note #44)
  { companyId: 8, q: 9, r: 4, label: "E23" }, // B&M -> Boston
];

/** Station Tokens (design note #36): a small, deliberately DUPLICATED copy
 *  of `StockMarketRenderer.tsx`'s own `TICKER_COLORS` -- same values, same
 *  `company_id` keys. See design note #36 for why this is copied rather
 *  than imported. */
const STATION_TICKER_COLORS: Readonly<Record<number, string>> = {
  1: "#c0392b", // PRR
  2: "#2980b9", // NYC
  3: "#8e44ad", // CPR
  4: "#27ae60", // B&O
  5: "#d68910", // C&O
  6: "#16a085", // ERIE
  7: "#b03a2e", // NNH
  8: "#34495e", // B&M
};
const STATION_FALLBACK_TICKER_COLOR = "#5a6270";

function stationTickerColor(companyId: number): string {
  return STATION_TICKER_COLORS[companyId] ?? STATION_FALLBACK_TICKER_COLOR;
}

/** Corporate Acronym Overlay guarantee (design note #45): a small,
 *  deliberately DUPLICATED copy of `public_company.rs`'s own
 *  `CORE_PUBLIC_COMPANIES` real on-chain tickers (same values, same
 *  `company_id` keys, same "copy, don't import" reasoning as
 *  `STATION_TICKER_COLORS` above). Exists so a RESERVED/unfloated home
 *  station badge can always draw its acronym even before `publicCompanies`
 *  has loaded (or ever loads) real data for that company -- see the muted
 *  drawing pass below, which now prefers a live `company.ticker` when
 *  present but falls back to this static table instead of an empty string.
 *  Company 7's real ticker is `NNH`, not `NYNH` -- `public_company.rs`'s
 *  `CORE_PUBLIC_COMPANIES` (`(7, "NNH")`) is the single source of truth;
 *  "NYNH" is this project's own established colloquial name for the real
 *  New York, New Haven & Hartford railroad the request refers to (see
 *  design note #36's own note on this), not a second, different on-chain
 *  ticker -- using "NNH" here keeps this placeholder text identical to
 *  what `company.ticker` will actually show once the corporation floats,
 *  so the badge's acronym never visibly changes/flickers at that moment. */
const STATION_TICKER_LABELS: Readonly<Record<number, string>> = {
  1: "PRR",
  2: "NYC",
  3: "CPR",
  4: "B&O",
  5: "C&O",
  6: "ERIE",
  7: "NNH",
  8: "B&M",
};

function stationTickerLabel(companyId: number): string {
  return STATION_TICKER_LABELS[companyId] ?? "";
}

/** Crisp Token Typography (design note #46): WCAG relative luminance of a
 *  `#rrggbb` hex color -- the standard sRGB-to-linear formula, used below to
 *  pick whichever of pure white/pure black actually contrasts better
 *  against a given badge fill, rather than assuming one fixed choice works
 *  for every corporate color. */
function relativeLuminance(hex: string): number {
  const toLinear = (channel: number): number => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const r = toLinear(parseInt(hex.slice(1, 3), 16));
  const g = toLinear(parseInt(hex.slice(3, 5), 16));
  const b = toLinear(parseInt(hex.slice(5, 7), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Crisp Token Typography (design note #46): returns whichever of pure
 *  white (`#FFFFFF`) or pure black (`#000000`) has the higher WCAG contrast
 *  ratio against `backgroundHex`, per the standard
 *  `(lighter + 0.05) / (darker + 0.05)` formula. See design note #46 for
 *  why this is picked dynamically per badge rather than one color asserted
 *  for every corporate ticker color -- several of `STATION_TICKER_COLORS`'s
 *  own established brand colors (duplicated from `StockMarketRenderer.tsx`,
 *  out of scope to re-tune here) don't actually reach the 7:1 AAA threshold
 *  against EITHER pure color alone; this always returns the better of the
 *  two available options, which is the closest a flat single-color badge
 *  fill can get without changing the brand palette itself. */
function bestContrastTextColor(backgroundHex: string): string {
  const bgLuminance = relativeLuminance(backgroundHex);
  const contrastWithWhite = 1.05 / (bgLuminance + 0.05);
  const contrastWithBlack = (bgLuminance + 0.05) / 0.05;
  return contrastWithWhite >= contrastWithBlack ? "#FFFFFF" : "#000000";
}

/** Mirrors `msg.rs`'s `LegalTilePlacement` exactly. */
export interface LegalTilePlacement {
  tile_id: number;
  orientation: number;
}

/** Mirrors `msg.rs`'s `LegalTilePlacementsResponse` exactly --
 *  `QueryMsg::GetLegalTilePlacements`'s response shape. */
export interface LegalTilePlacementsResponse {
  game_id: number;
  protocol_id: number;
  q: number;
  r: number;
  hex_label: string;
  placements: LegalTilePlacement[];
}

/** Discriminated union describing the click interceptor's in-flight/settled
 *  query state (see design note #7) -- reported to the host app via
 *  `onHexClickQuery` so `App.tsx` can decide when/where to render
 *  `<TileSelectionPopup />`. */
export type HexClickQueryState =
  | {
      status: "loading";
      q: number;
      r: number;
      hexLabel: string;
      clientX: number;
      clientY: number;
    }
  | {
      status: "success";
      q: number;
      r: number;
      hexLabel: string;
      clientX: number;
      clientY: number;
      response: LegalTilePlacementsResponse;
    }
  | {
      status: "error";
      q: number;
      r: number;
      hexLabel: string;
      clientX: number;
      clientY: number;
      message: string;
    }
  /** Design note #120: no chain client is wired up, so
   *  `GetLegalTilePlacements` was never called and `placements` below came
   *  from the LOCAL `TILE_CATALOG` mirror, not from the contract.
   *
   *  A separate status rather than a flag on `"success"` on purpose. These
   *  placements are NOT contract-validated: they are era-gated and nothing
   *  more -- no connectivity check, no terrain reservation, no tile-tray
   *  depletion, no upgrade-color step. Folding them into `"success"` would
   *  let any existing or future consumer treat unvalidated data as
   *  authoritative simply by not knowing to check a flag, whereas a distinct
   *  variant makes the exhaustiveness checker point at every site that has
   *  to decide. Consumers MUST surface this to the player as provisional and
   *  MUST NOT dispatch a `LayTile` from it. */
  | {
      status: "offline";
      q: number;
      r: number;
      hexLabel: string;
      clientX: number;
      clientY: number;
      placements: LegalTilePlacement[];
    };

/** `DoubleTown` (item 1/2, structural calibration pass): a single hex
 *  printing TWO independent town stops -- Akron & Canton (G7), Reading &
 *  Allentown (G17), New Haven & Hartford (F20) on the real board. Mirrors
 *  `state::TerrainType::DoubleTown` in the Rust backend exactly.
 *
 *  `DoubleCityHub` (Tile Selection Catalog verification pass): the same
 *  "two stops, one hex" pattern as `DoubleTown`, but for the four
 *  preprinted OO double-city hexes (`YELLOW_OO_HEXES`) instead of an
 *  ordinary town. Mirrors `state::TerrainType::DoubleCityHub` exactly --
 *  see `hexmap.rs` module doc comment #18 for the full backend enforcement
 *  this terrain now drives (an OO hex can only ever be upgraded with this
 *  terrain's tile, never plain `MajorCityHub`). */
/* ------------------------------------------------------------------ */
/* Tile catalog -- EXTRACTED (monolith split, Phase 1)                  */
/* ------------------------------------------------------------------ */
//
// `TerrainType`, `TileColorTier`, `TileCatalogEntry`, the 46-entry
// `TILE_CATALOG` mirror of `hexmap::TILE_CATALOG`, `TILE_CATALOG_BY_ID` and
// both dev-only drift tripwires now live in `./hexTileCatalog`.
//
// Re-exported here rather than merely imported, because these are part of
// this component's PUBLIC surface -- `App.tsx` and `TileSelectionPopup.tsx`
// both import `TerrainType`/`TileCatalogEntry` from this module today. A
// re-export keeps every existing import path working, so the extraction is
// invisible to consumers and can be verified as a pure move: no call site
// changed, and `tsc` proves the graph still resolves.
//
// The matching `import` of the same names is at the TOP of this file, not
// here -- `import/first`. Only these `export ... from` statements may sit in
// the module body.
export type { TerrainType, TileColorTier, TileCatalogEntry } from "./hexTileCatalog";
export { TILE_CATALOG_SIZE, TILE_CATALOG_BY_ID } from "./hexTileCatalog";

/** The three reserved 1830 landmark cities, at their VERIFIED REAL board
 *  coordinates (New York = G19, Boston = E23, Baltimore = I15 -- see design
 *  note #6 for sources and the coordinate transform). CROSS-FILE
 *  CONSISTENCY: RESOLVED -- `hexmap::LANDMARK_HEXES` in the Rust backend was
 *  updated to these same real coordinates (New York `(6, 6)`, Boston
 *  `(9, 4)`, Baltimore `(3, 8)`); this file's coordinates were the source of
 *  truth that pass aligned the backend to. */
// Design note #78: `displayName` is an OPTIONAL cosmetic override for the
// on-canvas nameplate ONLY -- `name` itself stays "New York" (structural,
// used as `LANDMARK_TRACKS`'s lookup key, and by every other place in this
// file that keys off a landmark's real name) so this doesn't ripple into
// `liveEdgesForHex`/`archetypeForHex`/etc. New York's real printed tile
// covers two cities, "New York & Newark" -- `displayName` lets the
// nameplate pass show that full name (and, since it contains " & ", pick
// up the SAME stacked two-line format the OO/double-town passes already
// use for other double-city names) without touching the structural key.
const LANDMARK_HEXES: ReadonlyArray<{ name: string; displayName?: string; q: number; r: number; label: string }> = [
  { name: "New York", displayName: "New York & Newark", q: 6, r: 6, label: "G19" },
  { name: "Boston", q: 9, r: 4, label: "E23" },
  { name: "Baltimore", q: 3, r: 8, label: "I15" },
];

/** Each landmark's authentic, fixed starting track -- see design note #6b
 *  for the sourced 18xx.games tile-definition strings and the compass-edge
 *  translation method. Each segment is an independent path with its own
 *  station: New York is modeled as TWO one-edge stub segments (its
 *  signature "one hex, two disconnected stations" design), while Boston and
 *  Baltimore are each a single two-edge through-route with one shared
 *  station. Edge numbers here are this file's own convention (design note
 *  #1: 0=E, 1=NE, 2=NW, 3=W, 4=SW, 5=SE), already translated from the
 *  source engine's differently-numbered edges. */
/** REVERTED (this pass, item 3 -- see design note #29 for the full
 *  investigation). The structural calibration pass's "CORRECTED... direct
 *  IDENTITY" edit below this comment (edges `[3]`/`[0]` for New York, `[3,
 *  5]` for Boston) put New York's edge-0/E stub at axial `(7, 6)` -- label
 *  "G21", which does not exist in `STATIC_BOARD_HEXES` at all (row G's real
 *  hexes stop at G19, New York itself) -- the same "points at a nonexistent
 *  hex" red flag design note #6b's own reflection derivation was built to
 *  catch, now catching the identity claim instead. Reflection is its own
 *  inverse, so re-applying the ORIGINAL, design-note-#6b-verified formula
 *  (`our_edge = ((4 - their_edge) % 6 + 6) % 6`) to the identity pass's
 *  edge values exactly recovers the values this file had before that pass:
 *  New York back to `[1]`/`[4]` (edge 1/NE -> F20 "New Haven & Hartford",
 *  edge 4/SW -> H18 "Philadelphia & Trenton" -- both real, named,
 *  already-modeled hexes in this same file, per design note #6b), Boston
 *  back to `[1, 5]`, Baltimore unchanged at `[0, 4]` (that set is its own
 *  reflection either way, per the identity pass's own correct observation).
 */
const LANDMARK_TRACKS: Readonly<Record<string, ReadonlyArray<{ edges: readonly number[] }>>> = {
  "New York": [{ edges: [1] }, { edges: [4] }],
  Boston: [{ edges: [1, 5] }],
  Baltimore: [{ edges: [0, 4] }],
};

/** THE tile background colour, by era tier -- design note #122.
 *
 *  One constant per era, full stop. Previously a laid tile's fill came from
 *  `TERRAIN_FILL` below, which is keyed on TERRAIN, so tiles of the same era
 *  painted different colours purely because of what was printed on them: a
 *  plain #9 came out `#f4ecd8`, a town #4 `#f0d9a0`, and the yellow city #57
 *  `#e8d9c0`. #57 sits on nearly every city hex on the board, so the single
 *  most-placed tile in the game was also the most visibly off-tray. Real
 *  1830 cardboard is one stock colour per era; the artwork on top varies,
 *  the card does not.
 *
 *  A second source of divergence went with it: the board loop used to
 *  override the fill to `PRINTED_HEX_FILL.Yellow` for any hex whose static
 *  entry was `printedColor: "Yellow"` (the landmarks and the four OO hexes),
 *  so an upgraded Green or Brown tile on one of those hexes kept painting
 *  yellow forever. Era now wins everywhere, which is also what tells a
 *  player at a glance that a hex has actually been upgraded.
 *
 *  Gray and Red are NOT here on purpose: they are properties of preprinted
 *  BOARD hexes, not of layable tile stock, and keep their own
 *  `BOARD_HEX_FILL`/`PRINTED_HEX_FILL` entries. `TileColorTier` has exactly
 *  three members and this map is total over them. */
const ERA_TILE_FILL: Readonly<Record<TileColorTier, string>> = {
  Yellow: "#f0d9a0",
  Green: "#c9e0b4",
  Brown: "#d8bc9a",
};

/* Design note #122 deleted `TERRAIN_FILL` from here. It mapped each
   TerrainType to its own tile background, and was the direct cause of the
   reported colour drift: same era, different card colour, depending on what
   was printed on the tile. `ERA_TILE_FILL` above replaced its last three
   call sites (board loop, ghost preview, picker thumbnail) and nothing else
   referenced it. Unlaid BOARD hexes were never its business -- those have
   always used `BOARD_HEX_FILL`/`PRINTED_HEX_FILL`, which are untouched. */


const COLOR_TIER_STROKE: Readonly<Record<TileColorTier, string>> = {
  Yellow: "#caa42a",
  Green: "#3f8f4f",
  Brown: "#8a5a2b",
};

/* ------------------------------------------------------------------ */
/* Static board background -- see design note #6                      */
/* ------------------------------------------------------------------ */

type BoardHexType = "Plain" | "Mountain" | "River" | "RedOffboard";

interface BoardHex {
  /** The hex's real 1830 board coordinate label (e.g. `"G19"`) -- included
   *  purely so this array can be independently cross-checked against the
   *  sources cited in design note #6. Not used for rendering. */
  label: string;
  q: number;
  r: number;
  type: BoardHexType;
  /** Set on hexes that are pre-printed GRAY (fixed, non-upgradeable) or
   *  pre-printed YELLOW (a real starting yellow tile, not a blank buildable
   *  hex) on the real board -- see design note #12 and `GRAY_HEXES`/
   *  `YELLOW_OO_HEXES` below. Overrides `BOARD_HEX_FILL[type]`'s fill/
   *  stroke (via `PRINTED_HEX_FILL`/`PRINTED_HEX_STROKE`) without changing
   *  `type` itself, so a hex like E5 can be BOTH a pre-printed yellow city
   *  AND a River (still gets its river icon/cost label -- both are true on
   *  the real board simultaneously). Undefined on ordinary blank/buildable
   *  hexes, which keep rendering exactly as before this pass. */
  printedColor?: "Gray" | "Yellow";
  /** Item 1 (structural calibration pass, Map Content Completion): set on
   *  the real board's ordinary WHITE (buildable, no printed track) hexes
   *  that nonetheless carry a preprinted Town/Double-Town DESIGNATION --
   *  verbatim-sourced from `tobymao/18xx`'s `g_1830/map.rb` `HEXES` `white:`
   *  section (`town=revenue:0` / `town=revenue:0;town=revenue:0` entries).
   *  `"single"`: London (E7), Burlington (B20), Flint (D4), Erie (F10) --
   *  four hexes, matching the real sourced count of preprinted Single-Town
   *  hexes. `"double"`: Akron & Canton (G7), Reading & Allentown (G17), New
   *  Haven & Hartford (F20) -- three hexes, matching the real sourced count
   *  of preprinted Double-Town hexes. Distinct from `GRAY_HEXES`'s
   *  `marker: "town"` entries (C15/I19/F24), which are real pre-printed GRAY
   *  hexes with FIXED starting track, not blank buildable hexes -- kept in
   *  lockstep with the Rust backend's `hexmap::TOWN_DESIGNATED_HEXES`
   *  (module doc comment #16), which enforces the matching on-chain
   *  placement rule. Undefined on every other hex. */
  townDesignation?: "single" | "double";
  /** Design note #34/item 2 ("Complete 1830 Baseline City Database"): the
   *  city-marker counterpart to `townDesignation` above -- set on ordinary
   *  WHITE (buildable, no printed track) hexes that carry a preprinted
   *  single-city marker on the real board, verbatim-sourced (and
   *  independently re-derived three times against the raw source text) from
   *  `tobymao/18xx`'s `g_1830/map.rb` `HEXES` `white:` section's plain
   *  `city=revenue:0` / `city` entries: Toledo (F4), Providence (F22),
   *  Pittsburgh (H10), Columbus (H4), Washington (J14), Lancaster (H16),
   *  Ottawa (B16), and Barrie (B10). Deliberately NOT modeled as a
   *  `GRAY_HEXES` entry: the real source has no `path=` data at all for any
   *  of these eight hexes (unlike an actual `GRAY_HEXES` city, which prints
   *  real fixed track), so -- exactly like `townDesignation` -- this draws
   *  only a placement-guide marker (`drawStationCircle`, no track), NOT
   *  real pre-printed track. UNLIKE `townDesignation`'s SmallTown/DoubleTown
   *  value, though, this DOES get the flat `MajorCityHub` ($20) pre-tile
   *  route value/badge, matching `townDesignation`'s own already-established
   *  precedent (added after design note #26/item 5's original city/town
   *  badge pass) of giving every printed destination marker -- including
   *  ordinary blank designated hexes with no real track yet -- a flat
   *  placeholder value, plus this item's own explicit "$20 base track
   *  value" ask. See design note #34 for the two corrections this uncovered
   *  (B16 is really Ottawa, not "Barrington"; F24 is really Mansfield, not
   *  "River Falls"). Undefined on every other hex. */
  cityDesignation?: boolean;
}

/** The complete, real 93-hex 1830 board -- see design note #6 for sources
 *  and the row-letter/column-number -> axial `(q, r)` transform this array
 *  was generated from. Unlike the previous illustrative pass, this is NOT
 *  a per-row `[qMin, qMax]` span generator: the real board's outline is
 *  genuinely non-convex (e.g. row A has a gap between columns 11 and 17 --
 *  hexes A13/A15 simply don't exist), so every one of the 93 real hexes is
 *  listed explicitly rather than approximated by a range. */
const STATIC_BOARD_HEXES: readonly BoardHex[] = [
  // Row A
  { label: "A9", q: 4, r: 0, type: "RedOffboard" }, // Canadian West
  { label: "A11", q: 5, r: 0, type: "RedOffboard" }, // Canadian West
  // A13/A15 are the real board's own gap (row A has no hex at columns 13/15
  // -- see design note #18) -- deliberately absent, not filled with any
  // decorative hex; that gap renders as the plain charcoal workspace
  // background, same as everywhere else outside the authentic 93-hex
  // footprint.
  { label: "A17", q: 8, r: 0, type: "Plain", printedColor: "Gray" }, // pure connector, no city
  { label: "A19", q: 9, r: 0, type: "Plain", printedColor: "Gray" }, // Montreal
  // Row B
  { label: "B10", q: 4, r: 1, type: "Plain", cityDesignation: true }, // Barrie
  { label: "B12", q: 5, r: 1, type: "Plain" },
  { label: "B14", q: 6, r: 1, type: "Plain" },
  // Ottawa -- NOT "Barrington" (see design note #34: verified three times
  // independently against the real sourced HEXES data, which names this
  // hex Ottawa; "Barrington" doesn't match any name in the source).
  { label: "B16", q: 7, r: 1, type: "Plain", cityDesignation: true },
  { label: "B18", q: 8, r: 1, type: "River" },
  { label: "B20", q: 9, r: 1, type: "Plain", townDesignation: "single" }, // Burlington
  { label: "B22", q: 10, r: 1, type: "Plain" },
  { label: "B24", q: 11, r: 1, type: "RedOffboard" }, // Maritime Provinces
  // Row C
  { label: "C7", q: 2, r: 2, type: "Plain" },
  { label: "C9", q: 3, r: 2, type: "Plain" },
  { label: "C11", q: 4, r: 2, type: "Plain" },
  { label: "C13", q: 5, r: 2, type: "Plain" },
  { label: "C15", q: 6, r: 2, type: "Plain", printedColor: "Gray" }, // Kingston
  { label: "C17", q: 7, r: 2, type: "Mountain" },
  { label: "C19", q: 8, r: 2, type: "River" },
  { label: "C21", q: 9, r: 2, type: "Mountain" },
  { label: "C23", q: 10, r: 2, type: "Plain" },
  // Row D
  { label: "D2", q: -1, r: 3, type: "Plain", printedColor: "Gray" }, // Lansing
  { label: "D4", q: 0, r: 3, type: "Plain", townDesignation: "single" }, // Flint
  { label: "D6", q: 1, r: 3, type: "River" },
  { label: "D8", q: 2, r: 3, type: "Plain" },
  { label: "D10", q: 3, r: 3, type: "River", printedColor: "Yellow" }, // Hamilton & Toronto (OO)
  { label: "D12", q: 4, r: 3, type: "Plain" },
  { label: "D14", q: 5, r: 3, type: "Plain", printedColor: "Gray" }, // Rochester
  { label: "D16", q: 6, r: 3, type: "Plain" },
  { label: "D18", q: 7, r: 3, type: "Plain" },
  { label: "D20", q: 8, r: 3, type: "Plain" },
  { label: "D22", q: 9, r: 3, type: "Mountain" },
  { label: "D24", q: 10, r: 3, type: "Plain", printedColor: "Gray" }, // pure connector, no city
  // Row E
  { label: "E3", q: -1, r: 4, type: "Plain" },
  { label: "E5", q: 0, r: 4, type: "River", printedColor: "Yellow" }, // Detroit & Windsor (OO)
  { label: "E7", q: 1, r: 4, type: "Plain", townDesignation: "single" }, // London
  { label: "E9", q: 2, r: 4, type: "Plain", printedColor: "Gray" }, // pure connector, no city
  { label: "E11", q: 3, r: 4, type: "Plain", printedColor: "Yellow" }, // Dunkirk & Buffalo (OO)
  { label: "E13", q: 4, r: 4, type: "Plain" },
  { label: "E15", q: 5, r: 4, type: "Plain" },
  { label: "E17", q: 6, r: 4, type: "Mountain" },
  { label: "E19", q: 7, r: 4, type: "Plain", cityDesignation: true }, // Albany -- a real, blank ($0) printed city (see NAMED_HEX_LABELS/HEX_START_VALUE_OVERRIDE); IS NYC's home as of design note #44's house rule (NYC/Albany, NNH now G19 -- see STATION_HOME_HEXES)
  { label: "E21", q: 8, r: 4, type: "Mountain" },
  { label: "E23", q: 9, r: 4, type: "Plain", printedColor: "Yellow" }, // Boston -- see LANDMARK_HEXES
  // Row F
  { label: "F2", q: -2, r: 5, type: "RedOffboard" }, // Chicago
  { label: "F4", q: -1, r: 5, type: "River", cityDesignation: true }, // Toledo
  { label: "F6", q: 0, r: 5, type: "Plain", printedColor: "Gray" }, // Cleveland
  { label: "F8", q: 1, r: 5, type: "Plain" },
  { label: "F10", q: 2, r: 5, type: "Plain", townDesignation: "single" }, // Erie
  { label: "F12", q: 3, r: 5, type: "Plain" },
  { label: "F14", q: 4, r: 5, type: "Plain" },
  // Scranton -- missed city, added by design note #123. Same
  // `cityDesignation: true` pattern as F4/Toledo (a blank, no-real-track
  // hex with a terrain type), the one existing precedent for a printed
  // terrain type PLUS a city marker together -- Toledo's is River
  // ("water"), this one is Mountain, the requested analog.
  { label: "F16", q: 5, r: 5, type: "Mountain", cityDesignation: true }, // Scranton
  { label: "F18", q: 6, r: 5, type: "Plain" },
  { label: "F20", q: 7, r: 5, type: "Plain", townDesignation: "double" }, // New Haven & Hartford
  { label: "F22", q: 8, r: 5, type: "River", cityDesignation: true }, // Providence
  // Mansfield -- kept as-is; NOT renamed to "River Falls" (see design note
  // #34: verified against the real sourced HEXES/LOCATION_NAMES data, which
  // names this hex Mansfield; "River Falls" doesn't match any name in the
  // source, and this exact "Mansfield" name was already independently
  // sourced and confirmed in an earlier pass -- see `GRAY_HEXES`' own F24
  // comment above and `NAMED_HEX_LABELS` below).
  { label: "F24", q: 9, r: 5, type: "Plain", printedColor: "Gray" }, // Mansfield
  // Row G
  { label: "G3", q: -2, r: 6, type: "Plain" },
  { label: "G5", q: -1, r: 6, type: "Plain" },
  { label: "G7", q: 0, r: 6, type: "Plain", townDesignation: "double" }, // Akron & Canton
  { label: "G9", q: 1, r: 6, type: "Plain" },
  { label: "G11", q: 2, r: 6, type: "Plain" },
  { label: "G13", q: 3, r: 6, type: "Mountain" },
  { label: "G15", q: 4, r: 6, type: "Mountain" },
  { label: "G17", q: 5, r: 6, type: "Plain", townDesignation: "double" }, // Reading & Allentown
  { label: "G19", q: 6, r: 6, type: "River", printedColor: "Yellow" }, // New York -- see LANDMARK_HEXES; RECLASSIFIED River by design note #71 (real 1830's own printed G19: `upgrade=cost:80,terrain:water`)
  // Row H
  { label: "H2", q: -3, r: 7, type: "Plain" },
  { label: "H4", q: -2, r: 7, type: "Plain", cityDesignation: true }, // Columbus
  { label: "H6", q: -1, r: 7, type: "Plain" },
  { label: "H8", q: 0, r: 7, type: "Plain" },
  { label: "H10", q: 1, r: 7, type: "Plain", cityDesignation: true }, // Pittsburgh
  { label: "H12", q: 2, r: 7, type: "Plain", printedColor: "Gray" }, // Altoona
  { label: "H14", q: 3, r: 7, type: "Plain" },
  { label: "H16", q: 4, r: 7, type: "Plain", cityDesignation: true }, // Lancaster
  { label: "H18", q: 5, r: 7, type: "Plain", printedColor: "Yellow" }, // Philadelphia & Trenton (OO)
  // Row I
  { label: "I1", q: -4, r: 8, type: "RedOffboard" }, // Gulf
  { label: "I3", q: -3, r: 8, type: "Plain" },
  { label: "I5", q: -2, r: 8, type: "Plain" },
  { label: "I7", q: -1, r: 8, type: "Plain" },
  { label: "I9", q: 0, r: 8, type: "Plain" },
  { label: "I11", q: 1, r: 8, type: "Mountain" },
  { label: "I13", q: 2, r: 8, type: "Plain" },
  { label: "I15", q: 3, r: 8, type: "Plain", printedColor: "Yellow" }, // Baltimore -- see LANDMARK_HEXES
  { label: "I17", q: 4, r: 8, type: "River" },
  { label: "I19", q: 5, r: 8, type: "Plain", printedColor: "Gray" }, // Atlantic City
  // Row J
  { label: "J2", q: -4, r: 9, type: "RedOffboard" }, // Gulf
  { label: "J4", q: -3, r: 9, type: "Plain" },
  { label: "J6", q: -2, r: 9, type: "Plain" },
  { label: "J8", q: -1, r: 9, type: "Plain" },
  { label: "J10", q: 0, r: 9, type: "Mountain" },
  { label: "J12", q: 1, r: 9, type: "Mountain" },
  { label: "J14", q: 2, r: 9, type: "River", cityDesignation: true }, // Washington
  // Row K
  { label: "K13", q: 1, r: 10, type: "RedOffboard" }, // Deep South
  { label: "K15", q: 2, r: 10, type: "Plain", printedColor: "Gray" }, // Richmond
];

/** Off-board revenue terminal display names, keyed by real board label --
 *  see design note #6. `A9`/`I1` are the real board's auxiliary "hidden"
 *  continuation hexes for the Canadian West / Gulf zones respectively (each
 *  off-board zone spans two hexes on the physical board and shares one
 *  revenue value between them); labeling both with their zone's name is
 *  more honest than picking one arbitrarily to omit. */
const OFFBOARD_LABELS: Readonly<Record<string, string>> = {
  F2: "Chicago",
  A9: "Canadian West",
  A11: "Canadian West",
  J2: "Gulf",
  I1: "Gulf",
  K13: "Deep South",
  B24: "Maritime Provinces",
};

/** Each off-board hex's pre-printed track stubs -- see design note #10 for
 *  the source and the edge-translation formula/verification. Edge numbers
 *  are this file's own convention (design note #1). */
const OFFBOARD_TRACKS: Readonly<Record<string, readonly number[]>> = {
  F2: [0, 1, 5], // Chicago -- real neighbors F4, E3, G3
  A9: [5], // Canadian West (1/2) -- real neighbor B10
  A11: [4, 5], // Canadian West (2/2) -- real neighbors B10, B12
  I1: [0], // Gulf (1/2) -- real neighbor I3
  J2: [0, 1], // Gulf (2/2) -- real neighbors J4, I3
  K13: [1, 2], // Deep South -- real neighbors J14, J12
  B24: [3, 4], // Maritime Provinces -- real neighbors B22, C23
};

/** Design note #26/item 3: the Gulf off-board zone's two hexes (I1/J2, both
 *  labeled "Gulf" above) are drawn as one visually merged region -- their
 *  shared interior edge's border stroke is suppressed (see `drawHexEdges`
 *  below) and they get a single centered nameplate instead of two. `I1`
 *  sits at `(q, r)` and `J2` at `(q, r + 1)` (edge index 5's direction, per
 *  `edgeAngleRad`'s `(dq, dr) = (0, +1)` neighbor -- confirmed against
 *  `OFFBOARD_TRACKS`'s own "real neighbor I3" comments above, which land on
 *  the same shared edge from both sides: I1's remaining live edge 0 points
 *  at I3, and J2's edge 1 also points at I3), so I1's edge 5 / J2's edge 2
 *  is the one shared interior edge to hide. */
const GULF_HIDDEN_EDGE: Readonly<Record<string, number>> = {
  I1: 5,
  J2: 2,
};

/** Item 9 (structural calibration pass, Merge Canadian West): applies the
 *  identical technique `GULF_HIDDEN_EDGE` above already established to the
 *  Canadian West off-board zone's own two hexes (A9/A11, both labeled
 *  "Canadian West" in `OFFBOARD_LABELS`) -- their shared interior edge's
 *  border stroke suppressed, one merged nameplate instead of two. `A9` sits
 *  at `(q, r) = (4, 0)` and `A11` at `(q, r) = (5, 0)`, a `(dq, dr) = (+1,
 *  0)` neighbor pair -- edge index 0 per `edgeAngleRad`'s convention -- so
 *  A9's edge 0 (facing A11) and A11's opposite edge 3 (facing A9) are the
 *  one shared interior edge to hide on each side. Real off-board terminal
 *  hexes carry no printed path connecting the two halves of a zone at all
 *  (they're a permanently-fixed, unbuildable revenue box, not track a
 *  Protocol lays) -- `OFFBOARD_TRACKS`'s own A9/A11 entries are each hex's
 *  stub toward its real neighboring PLAYABLE hex (B10/B12), a completely
 *  separate edge from this purely geometric shared-border seam, so this
 *  hidden-edge pair is derived straight from axial adjacency, the same way
 *  `GULF_HIDDEN_EDGE` was cross-checked, rather than from any `path=`
 *  source data. */
const CANADIAN_WEST_HIDDEN_EDGE: Readonly<Record<string, number>> = {
  A9: 0,
  A11: 3,
};

/** Each off-board destination's real printed Yellow/Brown revenue -- see
 *  design note #11 for the source and why there's no separate Green tier
 *  printed on the physical board. Keyed by the same display name
 *  `OFFBOARD_LABELS` uses. Restructured from a single display string into
 *  numeric tiers for design note #15/item 4: era-adaptive rendering needs
 *  the actual numbers, not a pre-formatted "$40/$70" string, to pick out
 *  just the currently-active era's value. */
interface OffboardRevenueTiers {
  yellow: number;
  brown: number;
}

const OFFBOARD_REVENUE: Readonly<Record<string, OffboardRevenueTiers>> = {
  Chicago: { yellow: 40, brown: 70 },
  "Canadian West": { yellow: 30, brown: 50 },
  Gulf: { yellow: 30, brown: 60 },
  "Deep South": { yellow: 30, brown: 40 },
  "Maritime Provinces": { yellow: 20, brown: 30 },
};

/** Resolves `tiers` to the single value that applies at `era` -- see design
 *  note #15. Real 1830 off-board boxes only ever print two numbers (see
 *  design note #11): the "Yellow" figure keeps applying through the Green
 *  era too (there's no distinct printed Green value), and the "Brown"
 *  figure takes over once Brown is reached. */
function offboardValueForEra(tiers: OffboardRevenueTiers, era: TileColorTier): number {
  return era === "Brown" ? tiers.brown : tiers.yellow;
}

/** Representative build cost for each buildable-but-costly terrain type --
 *  the real 1830 printed terrain costs (see design note #9).
 *
 *  PROMOTED (design note #118, backend Audit G-5/G-10): these two figures are
 *  no longer merely a legibility label that happened to sit next to the real
 *  number. Terrain is now charged as a HEX property, exactly as real 1830
 *  charges it -- `hexmap::execute_lay_tile` reads the fee from
 *  `terrain_build_fee(q, r)` ($80 river / $120 mountain / $0 clear land),
 *  paid once when a hex is first built on and free on every later colour
 *  upgrade. Every entry in `hexmap::TILE_CATALOG` now carries a `0` cost
 *  field, and the invented "river"/"mountain pass" tile artwork that used to
 *  carry the charge (old internal ids 4, 5, 12) is deleted. That closed both
 *  halves of the old exploit: laying an ordinary plain tile onto a real
 *  river or mountain hex used to be free, and laying the invented mountain
 *  artwork onto flat grassland used to charge $80 for nothing. So what this
 *  table shows is now the actual enforced figure for the hex beneath it.
 *
 *  Design note #94: `$` dropped from both values, per direct request --
 *  the red box itself (design note #68) already unambiguously marks this
 *  as a cost figure, so the bare number reads cleanly on its own. Feeds
 *  BOTH render paths (the plain-hex box and `drawTerrainCompoundBadge`)
 *  unchanged, since both just render whatever string this constant holds. */
/** Real 1830's printed water/river build fee, in VGP.
 *  Mirrors `hexmap::RIVER_BUILD_FEE` exactly. */
export const RIVER_BUILD_FEE = 80;

/** Real 1830's printed mountain build fee, in VGP.
 *  Mirrors `hexmap::MOUNTAIN_BUILD_FEE` exactly. */
export const MOUNTAIN_BUILD_FEE = 120;

/** What laying track on hex `(q, r)` costs in terrain fees -- design note
 *  #136 (F-2).
 *
 *  A DIRECT MIRROR of `hexmap::terrain_build_fee(q, r)`, structured the same
 *  way it is: look the hex up in the river set, then the mountain set, then
 *  charge nothing. `0` for ordinary clear ground, which is a real answer, not
 *  a missing one.
 *
 *  WHY BY COORDINATE RATHER THAN BY TERRAIN TYPE. This used to be a
 *  `Record<BoardHexType, string>` keyed on the hex's `type` field, which made
 *  the fee a property of a rendering CATEGORY. In real 1830 -- and in the
 *  contract since backend G-10 -- terrain cost is a property of the HEX:
 *  `hexmap::terrain_build_fee` takes `(q, r)` and consults
 *  `RIVER_HEXES`/`MOUNTAIN_HEXES`. Keying on a display type meant the two
 *  models could disagree about any hex whose rendering category and terrain
 *  membership ever diverged, and it made the frontend's number look like a
 *  UI constant rather than a mirrored contract value.
 *
 *  THE FIGURES ARE THE CONTRACT'S, AND THE SPEC DOCUMENT IS WRONG.
 *  `AUDIT_PART2_FRONTEND.md`'s F-2 records the spec as saying "$20 River /
 *  $80 Mountain". That is not real 1830 and not what this contract charges:
 *  `hexmap::RIVER_BUILD_FEE = 80` and `hexmap::MOUNTAIN_BUILD_FEE = 120`,
 *  which is also what the physical board prints. The renderer already showed
 *  $80/$120; the reconciliation needed was to the SPEC, not to the code, and
 *  the resolution is that the contract is the authority. These constants are
 *  named after their backend counterparts so the correspondence is checkable
 *  by grep rather than by memory.
 *
 *  STILL A MIRROR, and worth being honest about: no query surfaces
 *  `terrain_build_fee`, so this cannot read the figure off the chain the way
 *  `MapTileEntry.revenue` now does for tile revenue. If terrain fees ever
 *  become player-visible in a way that affects a decision beyond a label,
 *  they should be surfaced on a query and read from there. */
export function terrainBuildFeeAt(q: number, r: number): number {
  const hex = STATIC_BOARD_HEXES.find((entry) => entry.q === q && entry.r === r);
  if (!hex) return 0;
  if (hex.type === "River") return RIVER_BUILD_FEE;
  if (hex.type === "Mountain") return MOUNTAIN_BUILD_FEE;
  return 0;
}

const BOARD_HEX_FILL: Readonly<Record<BoardHexType, string>> = {
  Plain: "#33402f", // muted gray/green empty land
  // Mountain/River now use the SAME land fill as Plain -- see design note
  // #9: both are real BUILDABLE terrain in 1830, communicated by an icon
  // (drawMountainIcon/drawRiverIcon) rather than a solid non-land fill
  // that used to visually read as an impassable obstacle.
  Mountain: "#33402f",
  River: "#33402f",
  RedOffboard: "#7a2020", // red off-board revenue terminal
};

const BOARD_HEX_STROKE: Readonly<Record<BoardHexType, string>> = {
  Plain: "#5c6a52",
  Mountain: "#5c6a52",
  River: "#5c6a52",
  RedOffboard: "#4a1414",
};

/* ------------------------------------------------------------------ */
/* Pre-printed gray & yellow hexes -- see design note #12              */
/* ------------------------------------------------------------------ */

/** Overrides `BOARD_HEX_FILL`/`BOARD_HEX_STROKE` on any `BoardHex` carrying
 *  a `printedColor` -- see design note #12 and the `BoardHex.printedColor`
 *  doc comment. `Gray` approximates the real board's pre-printed gray tile
 *  cardstock; `Yellow` approximates a real starting yellow tile (matching
 *  `COLOR_TIER_STROKE.Yellow`'s gold stroke used for laid yellow tiles
 *  elsewhere in this file, for visual consistency). */
const PRINTED_HEX_FILL: Readonly<Record<"Gray" | "Yellow", string>> = {
  Gray: "#8a8f94",
  Yellow: "#e8d488",
};
const PRINTED_HEX_STROKE: Readonly<Record<"Gray" | "Yellow", string>> = {
  Gray: "#4a4e52",
  Yellow: "#caa42a",
};

/** One pre-printed gray hex's fixed track + city/town marker -- see design
 *  note #12 for the source (`tobymao/18xx`'s `HEXES` `gray:` block).
 *  REVERTED (this pass, item 3 -- see design note #29). The structural
 *  calibration pass's "CORRECTED... direct IDENTITY" edit (edges kept as
 *  the source engine's own raw numbers) put Montreal's (A19) edge-0/E stub
 *  at axial `(10, 0)` -- label "A21", which does not exist in
 *  `STATIC_BOARD_HEXES` at all (row A's real hexes stop at A19, Montreal
 *  itself) -- literally running that track off the printed board's own
 *  eastern edge. Since the identity bug applied to this whole table (not
 *  just the named cities), and reflection is its own inverse, every entry
 *  below is reverted by re-applying the ORIGINAL, design-note-#6b-verified
 *  formula (`our_edge = ((4 - their_edge) % 6 + 6) % 6`) to the identity
 *  pass's stored values -- each entry's own comment shows the before (last
 *  pass) -> after (this pass, reverted) edges. `marker`/interior comments
 *  are otherwise unchanged: `path=a:N,b:_0` is a stub from edge `N` into
 *  the hex's own station node; `path=a:N,b:M` with no `_0` is a bare
 *  through-connector with no station at all -- the `E9`/`A17`/`D24`
 *  "none"-marker hexes. `marker` selects which station glyph
 *  `drawPrintedTrack` paints: `"city"` (large white station circle), `"town"`
 *  (small dark dit marker), or `"none"` (no passenger stop). Two gray hexes
 *  (H12 Altoona, D14 Rochester) have a third real path in the source that
 *  bypasses their own city circle entirely (a real 1830 "some trains skip
 *  this stop" rule) -- simplified away here, same as this file's other
 *  "track rendering is this component's own convention" simplifications
 *  (design note #3): the city's own through-connection is still drawn, just
 *  not the separate bypass-only path. */
interface GrayHexTrack {
  edges: readonly number[];
  marker: "city" | "town" | "none";
  /** Item (Precise Geometric Track Calibration pass): the real source has a
   *  THIRD path for this hex -- `path=a:1,b:4` for Altoona (18xx.games edge
   *  numbering) -- that connects the same two edges as the main line but
   *  does NOT touch the `_0` city node (`b:_0` is absent from that specific
   *  path entry), i.e. a real 1830 "some trains skip this stop" bypass.
   *  Translated via this file's own `our_edge = ((4 - their_edge) % 6 + 6) %
   *  6` formula (design note #6b), edges 1/4 land on this file's edges
   *  3/0 -- the SAME pair as `edges` below for H12, just drawn as a second,
   *  separate curve that visibly loops clear of the station circle instead
   *  of passing through it. Previously simplified away (see design note #12
   *  doc comment above); reinstated here since it was asked for by name.
   *  Rochester (D14) has the identical real bypass in the source and is
   *  NOT given one here -- out of scope for this pass, flagged rather than
   *  silently matched. */
  bypass?: boolean;
}

const GRAY_HEXES: Readonly<Record<string, GrayHexTrack>> = {
  D2: { edges: [0, 5], marker: "city" }, // Lansing -- was [4, 5]
  F6: { edges: [4, 5], marker: "city" }, // Cleveland -- was [0, 5]
  E9: { edges: [1, 2], marker: "none" }, // pure connector, no city -- was [2, 3]
  H12: { edges: [0, 3], marker: "city", bypass: true }, // Altoona (main line 0/3, real bypass fork reinstated -- see `bypass` doc comment) -- was [1, 4]
  D14: { edges: [0, 3, 4], marker: "city" }, // Rochester -- was [0, 1, 4]
  C15: { edges: [1, 3], marker: "town" }, // Kingston -- {1, 3} is its own reflection, unchanged
  K15: { edges: [2], marker: "city" }, // Richmond (dead-end stub) -- edge 2 is its own reflection, unchanged
  A17: { edges: [4, 5], marker: "none" }, // pure connector, no city -- was [0, 5]
  A19: { edges: [4, 5], marker: "city" }, // Montreal -- was [0, 5]; old edge 0/E pointed at nonexistent "A21"
  I19: { edges: [2, 3], marker: "town" }, // Atlantic City -- was [1, 2]
  F24: { edges: [2, 3], marker: "town" }, // Mansfield -- was [1, 2]
  D24: { edges: [3, 4], marker: "none" }, // pure connector, no city -- was [0, 1]
};

/** Fixed set of board-edge crossings across which track may never be built
 *  (design note #38) -- the frontend's drawing-only mirror of the backend's
 *  `hexmap::IMPASSABLE_HEX_EDGES` (module doc comment #22), which enforces
 *  the actual placement legality; this table exists purely so `draw()` can
 *  paint a thick red bar across each blocked crossing. Each entry is one
 *  representative `(q, r, edge)` per border -- unlike the backend's table,
 *  which lists BOTH hexes' own edge (since it needs to reject a lay attempt
 *  from either side), this only needs to draw the line once, so only one
 *  side of each border is listed here. `q`/`r` match `STATIC_BOARD_HEXES`'
 *  own entries for that label exactly (E7 `{q:1,r:4}`, D12 `{q:4,r:3}`, C17
 *  `{q:7,r:2}`); `edge` is this file's own 0-5 convention (`edgeAngleRad`),
 *  independently cross-checked against the backend's identical derivation
 *  from `HEX_NEIGHBOR_OFFSETS`. */
const IMPASSABLE_BORDER_EDGES: ReadonlyArray<{ q: number; r: number; edge: number; label: string }> = [
  { q: 1, r: 4, edge: 5, label: "E7 / F8" },
  { q: 4, r: 3, edge: 2, label: "D12 / C11" },
  { q: 4, r: 3, edge: 1, label: "D12 / C13" },
  { q: 7, r: 2, edge: 2, label: "C17 / B16" },
];

/** Pre-printed YELLOW "OO" double-city hexes -- two real, separately
 *  revenue-earning cities sharing one hex, printed with NO connecting track
 *  between them at all (verbatim-confirmed: none of these four hexes' real
 *  tile-definition strings contain a `path=` entry) -- players must
 *  eventually upgrade past this starting tile to actually connect the two
 *  stations. `drawOOCityMarkers` renders exactly that: two independent
 *  station circles, no track. `hasWaterCost` hexes (Detroit & Windsor,
 *  Hamilton & Toronto) also carry a real `$80` water upgrade cost --
 *  already modeled by this file's existing River terrain/icon/cost-label
 *  system (see `BoardHex.printedColor`'s doc comment: these hexes keep
 *  `type: "River"` alongside `printedColor: "Yellow"`), so no separate
 *  field is needed here for that. */
const YELLOW_OO_HEXES: ReadonlySet<string> = new Set(["E5", "D10", "E11", "H18"]);

/** Display names for every named gray/yellow-OO hex -- see design note #12.
 *  Sourced verbatim from `tobymao/18xx`'s `LOCATION_NAMES` table. E9, A17,
 *  and D24 are intentionally absent: they're real hexes with real
 *  pre-printed track (see `GRAY_HEXES` above) but no city/town at all, and
 *  `LOCATION_NAMES` itself has no entry for them either.
 *
 *  Item 1 (structural calibration pass, Map Content Completion) adds the
 *  seven ordinary white Town/Double-Town-designated hexes' names too (see
 *  `BoardHex.townDesignation`'s doc comment for the source and the exact
 *  4 Single-Town / 3 Double-Town split).
 *
 *  Design note #34/item 2 adds the eight ordinary white single-city-
 *  designated hexes' names too (see `BoardHex.cityDesignation`'s doc
 *  comment for the source) -- Toledo/Providence/Pittsburgh/Columbus/
 *  Washington/Lancaster/Barrie, plus Ottawa (B16, corrected from an earlier
 *  pass's own suggested "Barrington", which doesn't match the source; see
 *  design note #34).
 *
 *  F24 below is "Fall River", NOT the real board's own "Mansfield" name --
 *  design note #36/item 3 explicitly asked for this as "our preferred
 *  title" (contrasted, in that same request, with B16's explicitly
 *  "authentic rulebook name" Ottawa), i.e. a deliberate house-rule cosmetic
 *  override, not a claim that "Fall River" is what the sourced 18xx data
 *  actually says -- unlike an EARLIER pass's "River Falls" ask, which WAS
 *  framed as factual and was correctly declined (design note #34) since it
 *  didn't match the source. This one is honored as-given: the real board
 *  name is still "Mansfield" (`GRAY_HEXES`' own F24 entry/comment, and
 *  `hexmap.rs`'s `TOWN_DESIGNATED_HEXES`, are both left saying so in their
 *  own comments for the historical record), but the display name here is
 *  now the requested custom override. */
const NAMED_HEX_LABELS: Readonly<Record<string, string>> = {
  D2: "Lansing",
  F6: "Cleveland",
  H12: "Altoona",
  D14: "Rochester",
  C15: "Kingston",
  K15: "Richmond",
  A19: "Montreal",
  I19: "Atlantic City",
  F24: "Fall River", // custom override of the real board name "Mansfield" -- see doc comment above
  E5: "Detroit & Windsor",
  D10: "Hamilton & Toronto",
  E11: "Dunkirk & Buffalo",
  H18: "Philadelphia & Trenton",
  E7: "London",
  B20: "Burlington",
  D4: "Flint",
  F10: "Erie",
  G7: "Akron & Canton",
  G17: "Reading & Allentown",
  F20: "New Haven & Hartford",
  F4: "Toledo",
  F22: "Providence",
  H10: "Pittsburgh",
  H4: "Columbus",
  // Design note #106: reverted to the bare "Washington" -- reported the
  // longer "Washington, D.C." (design note #47's own explicit request,
  // above) extends off the hex, and the fix requested was specifically to
  // drop "D.C." rather than relocate the nameplate to a different slot
  // ("To make absolutely sure there's room, let's remove 'DC' from the
  // nameplate").
  J14: "Washington",
  H16: "Lancaster",
  B16: "Ottawa",
  B10: "Barrie",
  E19: "Albany",
  F16: "Scranton", // design note #123 -- missed city, added
};

/** Design note #35/items 2-3 ("Accurate 1830 Base Value Corrections" /
 *  "Zero-Value for Preprinted OO, Gray, and Landmark Additions"): per-hex
 *  overrides to the flat `terrainBaseValue("MajorCityHub") = $20` this file
 *  otherwise uses uniformly for every city-marker hex, keyed by real board
 *  label. Consulted by `hexRouteValue` (tooltip) and the value-badge drawing
 *  passes below BEFORE their existing flat-by-terrain fallback, so any hex
 *  NOT listed here (Lansing D2, Rochester D14, Richmond K15 -- three of the
 *  `GRAY_HEXES` city markers with no individually-sourced figure verified
 *  yet -- plus every `townDesignation` hex) is completely unaffected, still
 *  flat $20/$10 as before. Altoona H12 WAS one of these four originally,
 *  but a later pass (Rigid Global Gray-Hex Lockout, backend `hexmap.rs`
 *  module doc comment #20) independently sourced its real figure at $10 --
 *  see that entry below, and the FACTUAL CORRECTION paragraph after this
 *  one for the paired Town-reclassification claim that same pass rejected.
 *
 *  SOURCE VERIFICATION (independently re-derived twice against the raw
 *  `tobymao/18xx` `g_1830/map.rb` source text this file has cited
 *  throughout -- design notes #6/#12/#34): New York's real printed starting
 *  track is `'city=revenue:40;city=revenue:40;...'` (two $40 stations --
 *  this file's own `LANDMARK_TRACKS` doc comment already cited this exact
 *  string, just never wired it into the value-badge system before now),
 *  Boston is `'city=revenue:30;...'`, Baltimore is `'city=revenue:30;...'`,
 *  Montreal (A19) is `'city=revenue:40;...'`. FACTUAL CORRECTION: this
 *  item's own request labeled F6 "Chicago" -- F6 is real, verified Cleveland
 *  (`'city=revenue:30;...'`, confirmed against the same source's
 *  `LOCATION_NAMES` table too); Chicago is the real off-board hex F2, a
 *  completely different hex already modeled by `OFFBOARD_LABELS`/
 *  `OFFBOARD_REVENUE` on its own, era-tiered value system. Applied
 *  Cleveland's real $30 at F6, not a "Chicago" entry that would have been
 *  meaningless (F6 isn't Chicago, and Chicago already has its own value
 *  system this table doesn't touch).
 *
 *  The four `YELLOW_OO_HEXES` (design note #12) are ALSO independently
 *  confirmed at real `$0`: their source strings are
 *  `'city=revenue:0;city=revenue:0;label=OO;...'` -- both stations on EVERY
 *  one of these four hexes are printed with an explicit `revenue:0`, not
 *  merely an unspecified/default value, so `$0` here is the hex's genuine
 *  printed value, not an approximation. The eight `cityDesignation` hexes
 *  (design note #34) were already independently confirmed at `$0` last pass
 *  (bare `city`/`city=revenue:0` entries, no revenue figure at all) --
 *  restated here as the single source of truth the badge/tooltip code
 *  actually reads, superseding design note #34's own decision to show a
 *  flat $20 there (that decision predates this more precise source read).
 *
 *  FACTUAL CORRECTION (count): this item's own list of "8 newly injected
 *  city hubs" actually named nine hexes, including "River Falls F24" --
 *  F24 is NOT one of design note #34's eight `cityDesignation` hexes at
 *  all; it's Mansfield, a `GRAY_HEXES` `marker: "town"` hex (a real
 *  pre-printed Single-Town, `SmallTown` terrain, already correctly valued
 *  at its own flat $10 town rate since design note #12, long before design
 *  note #34's city-hub pass existed). Zeroing it out here would have
 *  silently overwritten an already-correct, independently-sourced $10 with
 *  an inapplicable city-hub $0 override. F24 is deliberately absent from
 *  this table; the eight hexes below are the real, complete
 *  `cityDesignation` set. B16 is, again, really Ottawa, not "Barrington"
 *  (design note #34) -- restated rather than silently re-applied.
 *
 *  ALTOONA (H12) CORRECTION (Rigid Global Gray-Hex Lockout pass): a request
 *  asked to reclassify Altoona from `MajorCityHub`/City to a Town, citing
 *  a paired $10 value. Independently re-verified TWICE against the real
 *  `tobymao/18xx` `g_1830/map.rb` source: H12's actual entry is
 *  `'city=revenue:10,loc:2.5;path=a:1,b:_0;path=a:4,b:_0;path=a:1,b:4'` --
 *  an explicit `city=` entry, not `town=`. Altoona genuinely IS a City on
 *  the real board; the $10 VALUE is correct (cities aren't always $20 --
 *  Cleveland/Boston/Baltimore above are real $30 cities, for the same
 *  reason), but the Town reclassification is not. Applied here as a value
 *  override only -- `GRAY_HEXES.H12`'s `marker: "city"` stays unchanged
 *  (white station circle, not a dark town dit), and no `TerrainType`
 *  changes on the backend either (`hexmap.rs` module doc comment #20). */
const HEX_START_VALUE_OVERRIDE: Readonly<Record<string, number>> = {
  G19: 40, // New York
  E23: 30, // Boston
  I15: 30, // Baltimore
  A19: 40, // Montreal
  F6: 30, // Cleveland -- NOT "Chicago" (see doc comment above)
  H12: 10, // Altoona -- real City (NOT a Town), real sourced $10, not the generic $20 -- backend module doc comment #20
  E5: 0, // Detroit & Windsor (OO)
  D10: 0, // Hamilton & Toronto (OO)
  E11: 0, // Dunkirk & Buffalo (OO)
  H18: 0, // Philadelphia & Trenton (OO)
  F4: 0, // Toledo
  F22: 0, // Providence
  H10: 0, // Pittsburgh
  H4: 0, // Columbus
  J14: 0, // Washington
  H16: 0, // Lancaster
  B16: 0, // Ottawa
  B10: 0, // Barrie
  E19: 0, // Albany -- real source string is a bare 'city' entry (re-verified against
  // tobymao/18xx g_1830/map.rb this pass), no `revenue:` figure at all -- same blank-city
  // category as the eight cityDesignation hexes above, not a printed-value city like
  // Cleveland/Boston/Baltimore. See design note #42 for the full Rail Map Overhaul writeup.
  F16: 0, // Scranton -- design note #123, same blank-city ($0) category as the rest above
};

/* ------------------------------------------------------------------ */
/* Hex geometry (pointy-top axial) -- see design note #1              */
/* ------------------------------------------------------------------ */

/** Pointy-top axial `(q, r)` -> pixel center, standard conversion. */
function axialToPixel(q: number, r: number, size: number): { x: number; y: number } {
  return {
    x: size * (Math.sqrt(3) * q + (Math.sqrt(3) / 2) * r),
    y: size * (1.5 * r),
  };
}

/** Edge `i`'s direction angle, in radians, from a tile's center -- see
 *  design note #1 for why this is `-60 * i`, not `+60 * i`. */
function edgeAngleRad(edgeIndex: number): number {
  return (-60 * edgeIndex * Math.PI) / 180;
}

/** Hexagon corner `i`'s direction angle, in radians -- offset 30deg ahead
 *  of edge `i`'s own angle, so corner `i` and corner `(i + 1) % 6` flank
 *  edge `i` on either side. */
function cornerAngleRad(cornerIndex: number): number {
  return ((30 - 60 * cornerIndex) * Math.PI) / 180;
}

function pointOnCircle(
  center: { x: number; y: number },
  radius: number,
  angleRad: number,
): { x: number; y: number } {
  return {
    x: center.x + radius * Math.cos(angleRad),
    y: center.y + radius * Math.sin(angleRad),
  };
}

/** Axial-coordinate neighbor offsets, indexed by edge (0-5) -- byte-for-byte
 *  the same six deltas as the backend's `hexmap::HEX_NEIGHBOR_OFFSETS`
 *  (design note #1's own source for `edgeAngleRad`'s `-60 * i` derivation),
 *  finally given its own named constant here rather than staying implicit.
 *  Edge `i` on a tile at `(q, r)` touches the tile at `(q +
 *  HEX_NEIGHBOR_OFFSETS[i][0], r + HEX_NEIGHBOR_OFFSETS[i][1])`. */
const HEX_NEIGHBOR_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
];

/** Whether ANY real board hex -- landmark, ordinary track/blank hex, or
 *  off-board revenue terminal -- is defined at `(q, r)`. `LANDMARK_HEXES`
 *  and `STATIC_BOARD_HEXES` together are this file's complete 93-hex board
 *  (an off-board hex like Chicago is still a `STATIC_BOARD_HEXES` entry,
 *  just one `OFFBOARD_LABELS` also names -- very much a place real track
 *  points AT, so it counts as "exists" here, unlike a coordinate with no
 *  entry in either table at all, which is genuinely empty canvas space
 *  outside the board's actual footprint). Used by `deadEdgesAt` below. */
function boardHexExistsAt(q: number, r: number): boolean {
  return (
    LANDMARK_HEXES.some((l) => l.q === q && l.r === r) ||
    STATIC_BOARD_HEXES.some((h) => h.q === q && h.r === r)
  );
}

/** Design note #39: edges of hex `(q, r)` whose neighboring coordinate
 *  isn't a real board hex at all (see `boardHexExistsAt`) -- e.g. Baltimore
 *  (I15)'s edge 5 (SE), which points off the printed board's actual
 *  footprint entirely, unlike its edges 0/E (toward I17) and 4/SW (toward
 *  J14, Washington), both real neighboring hexes a route could eventually
 *  extend through. An edge in this set can NEVER carry live track from
 *  either side, for any tile, ever -- there's nothing there to build a
 *  connecting tile on -- making it a strictly stronger, permanent
 *  guarantee than "not currently live." `drawValueBadge` uses this to
 *  prefer parking a badge next to a permanently dead edge over one that's
 *  merely not live *yet* (module doc comment on `BADGE_CORNERS` has the
 *  full reasoning, including why this generalizes past landmarks to every
 *  gray-hex/laid-tile badge too). */
function deadEdgesAt(q: number, r: number): number[] {
  const dead: number[] = [];
  for (let edge = 0; edge < 6; edge++) {
    const [dq, dr] = HEX_NEIGHBOR_OFFSETS[edge];
    if (!boardHexExistsAt(q + dq, r + dr)) dead.push(edge);
  }
  return dead;
}

/* ------------------------------------------------------------------ */
/* Margin label sizing -- shared between the camera fit and the label */
/* placement itself (see design note re: "Vertical Margin Label       */
/* Clearance" / the follow-up "Camera Padding Must Reserve Room For   */
/* Margin Labels" pass)                                               */
/* ------------------------------------------------------------------ */
//
// `boardContentBounds` (the camera's own fit/pan/zoom bounds, computed as a
// plain `useMemo` with no canvas context available yet) and
// `computeBoardMarginLabels` (the exact per-label placement, computed later
// WITH a real `ctx` to call `measureText`) both need to agree on how much
// extra room, beyond each edge hex's own true rendered corner, is reserved
// for the row/column labels drawn just outside the board. If the camera
// reserves less than the label placement actually needs, labels get
// clipped off the visible canvas; if the camera reserves less than the
// hex's own corner-to-label distance, labels render ON TOP of the
// outermost hex instead of outside it (the original bug report). A prior
// pass (design note #26) tightened `boardContentBounds`'s padding to
// exactly `hexSize` -- precisely the hex's own center-to-corner radius,
// with ZERO slack left over for anything drawn beyond that corner. That
// was fine for hiding excess dead space around the board, but it silently
// left no room at all for margin labels, which is the deeper reason
// column-number labels (whose necessary clearance sits right at that
// zero-slack corner point, see the comment on `computeBoardMarginLabels`'s
// Y-axis budget) kept overlapping the top/bottom hexes even after the
// width-vs-height measurement bug was fixed. This constant/helper pair
// restores a SMALL, proportional (not a large flat pixel constant)
// reservation sized off `hexSize`/`fontSize` alone, so both call sites can
// derive the identical value without either one needing a canvas context.
export const MARGIN_LABEL_BACKGROUND_PADDING_PX = 4;
export const MARGIN_LABEL_EXTRA_INSET_PX = 8;

/** The exact font size `drawBoardMarginLabels` renders margin labels at --
 *  a single shared formula so nothing else has to re-derive or guess it. */
function marginLabelFontSize(hexSize: number): number {
  return Math.max(11, hexSize * 0.3);
}

/** How much extra room, beyond a hex's own true center-to-corner radius
 *  (`hexSize`), the camera must additionally reserve so a margin label can
 *  be drawn just outside that corner without being clipped by the
 *  camera's own edge. This is an ESTIMATE (no canvas context is available
 *  where `boardContentBounds` needs it) -- `computeBoardMarginLabels`
 *  still does its own exact `ctx.measureText` pass for the real placement;
 *  this only has to be generous enough that the exact pass never needs
 *  more room than the camera already set aside. Two-character column
 *  numbers ("10" .. "22") are the widest/tallest labels this board ever
 *  draws, so a `1.4x` multiplier on the font size comfortably covers a
 *  bold sans-serif digit pair's rendered box in either dimension, without
 *  hardcoding an absolute pixel value disconnected from `hexSize`. */
function marginLabelReserve(hexSize: number): number {
  const fontSize = marginLabelFontSize(hexSize);
  return fontSize * 1.4 + MARGIN_LABEL_BACKGROUND_PADDING_PX + MARGIN_LABEL_EXTRA_INSET_PX;
}

/** Rotates a 6-bit edge bitmask by `orientation` steps (0-5) -- a direct
 *  TypeScript port of `hexmap::rotate_connections`, kept bit-for-bit
 *  identical so a laid tile's actual on-screen edges always match what
 *  the contract itself considers "live" at that orientation. */
function rotateConnections(mask: number, orientation: number): number {
  const o = ((orientation % 6) + 6) % 6;
  const m = mask & 0b111111;
  if (o === 0) return m;
  return ((m << o) | (m >> (6 - o))) & 0b111111;
}

/* Design note #121 removed `rotatePaths` and `pathsForTile` from here.
   Both existed only to feed the generalized double-town renderer that
   `DOUBLE_TOWN_ROUTES` replaced: `rotatePaths` turned catalog edge pairs
   into rotated ones, and `pathsForTile` picked query data over the mirror.
   The explicit artwork table keys on `tileId` and rotates its own two edges
   inline, so neither had a caller left. `msg::MapTileEntry::paths` is still
   populated by the contract and still mirrored on `TileCatalogEntry.paths`
   -- the mirror now feeds the drift tripwire beside that table -- but this
   renderer no longer reads the per-tile query value for artwork. */

/** Every `(tile_id, orientation)` pairing in the LOCAL catalog mirror --
 *  design note #120's offline fallback for the tile picker, used only when
 *  no chain client is wired up.
 *
 *  Design note #125: this no longer filters by era. It used to return only
 *  the tiers a room in `currentEra` had unlocked, which meant a fresh
 *  offline session showed the twelve Yellow tiles and nothing else, with no
 *  way to reach the other thirty-four -- the player was stuck looking at one
 *  tray. Offline mode exists to INSPECT the catalog, and `TileSelectionPopup`
 *  now has era tabs to browse it, so the filtering moved there where it is a
 *  view control the player can change rather than a wall.
 *
 *  This does not weaken any rule, because it was never enforcing one. The
 *  result carries no legality claim of any kind: no era lock, no track
 *  connectivity, no landmark/OO/"B"/"NY" reservation, no upgrade colour
 *  step, no tray depletion. That is why it goes out under the `"offline"`
 *  status the UI must label as provisional and must not dispatch from --
 *  reimplementing `hexmap::legal_tile_placements` here would create a second
 *  copy of the rules to drift out of sync, the exact hazard
 *  `TileSelectionPopup`'s design note #4 exists to prevent.
 *
 *  All six orientations are offered for every tile, since without the
 *  contract there is no basis for excluding any of them. */
function localCatalogPlacements(): LegalTilePlacement[] {
  const placements: LegalTilePlacement[] = [];
  for (const entry of TILE_CATALOG) {
    for (let orientation = 0; orientation < 6; orientation++) {
      placements.push({ tile_id: entry.tileId, orientation });
    }
  }
  return placements;
}

function liveEdges(mask: number): number[] {
  const edges: number[] = [];
  for (let i = 0; i < 6; i++) {
    if (mask & (1 << i)) edges.push(i);
  }
  return edges;
}

/** Inverse of `axialToPixel` for pointy-top axial hexes, followed by cube
 *  rounding -- the standard redblobgames algorithm. `x`/`y` must already be
 *  in the hex layer's own untransformed coordinate space (i.e. with the
 *  canvas's pan/zoom already divided out by the caller -- see
 *  `handlePointerUp` below, which undoes `draw()`'s own
 *  `ctx.translate`/`ctx.scale` before calling this). */
function pixelToAxial(x: number, y: number, size: number): { q: number; r: number } {
  const qFrac = ((Math.sqrt(3) / 3) * x - (1 / 3) * y) / size;
  const rFrac = ((2 / 3) * y) / size;
  return axialRound(qFrac, rFrac);
}

/** Standard cube-coordinate rounding: converts fractional axial `(q, r)` to
 *  cube `(x, y, z)` with `x + y + z === 0`, rounds each axis independently,
 *  then re-derives whichever axis had the largest rounding error from the
 *  other two so the zero-sum invariant still holds -- the textbook
 *  "which hex is under this pixel" hit-testing algorithm. */
function axialRound(qFrac: number, rFrac: number): { q: number; r: number } {
  const xFrac = qFrac;
  const zFrac = rFrac;
  const yFrac = -xFrac - zFrac;

  let x = Math.round(xFrac);
  let y = Math.round(yFrac);
  let z = Math.round(zFrac);

  const xDiff = Math.abs(x - xFrac);
  const yDiff = Math.abs(y - yFrac);
  const zDiff = Math.abs(z - zFrac);

  if (xDiff > yDiff && xDiff > zDiff) {
    x = -y - z;
  } else if (yDiff > zDiff) {
    y = -x - z;
  } else {
    z = -x - y;
  }

  return { q: x, r: z };
}

/** Dynamic City Nameplate Suppression (design note #47): true once a real
 *  tile (any color -- Yellow, Green, or Brown) has actually been laid at
 *  `(q, r)`. Physical-board parity: in real 1830, laying a tile physically
 *  covers the hex's preprinted city name -- every preprinted-name drawing
 *  pass below now skips its text once this is true, matching that. Shares
 *  the exact `mapGrid.tiles.find((t) => t.q === q && t.r === r)` lookup
 *  this file's OTHER `mapGrid`-aware passes already use (the laid-tile fill
 *  pass, the click interceptor's own `laidTile` lookup) rather than a new
 *  pattern. Deliberately NOT applied to `drawOffboardNameplate`'s zone
 *  names -- an off-board hex can never receive a laid tile at all (Off-
 *  Board Reservation, `hexmap.rs` module doc comment #14), so that check
 *  would always be false there anyway; nor to the value-badge pass further
 *  below, which this request's own "text plate" wording didn't ask to
 *  change. */
function hexHasLaidTile(mapGrid: MapGridResponse, q: number, r: number): boolean {
  return mapGrid.tiles.some((tile) => tile.q === q && tile.r === r);
}

/** ================================================================
 *  UNIVERSAL CANVAS LAYOUT ENGINE (design note #55)
 *  ================================================================
 *  Every hex's station-node/nameplate/badge placement is derived from ONE
 *  shared classifier, `archetypeForHex`, rather than one-off per-hex-name
 *  branches scattered across the file. The rule this section enforces: NO
 *  rendering code may ever branch on a specific hex's `label`/`name`/`q,r`
 *  literal (e.g. `hex.label === "G19"`, `name === "Boston"`) to decide
 *  WHERE something gets drawn -- only on STRUCTURAL tile/terrain data that
 *  would classify identically for any other hex with the same real
 *  properties. Genuine per-hex DATA (a city's own name string, a
 *  landmark's own real sourced printed-track edges in `LANDMARK_TRACKS`,
 *  which tile artwork is legal where) is not itself a "hack" -- every board
 *  game inherently has per-hex facts -- so those tables stay untouched;
 *  what changes is that no PLACEMENT FORMULA is keyed off hex identity
 *  anymore, only off which of the four archetypes below a hex's REAL
 *  current tile/terrain data resolves to. */
export type HexArchetype = "SingleCity" | "DoubleCity" | "SingleTown" | "DoubleTown" | "Plain";

/** Structural terrain -> archetype mapping -- every `TerrainType` maps to
 *  exactly one archetype, purely by what KIND of city/town it draws (one
 *  station node vs two), never by which specific tile id or hex it is.
 *  `MajorCityHub`/`BostonHub` share "SingleCity" because they both draw
 *  exactly one station node (Boston's own hub artwork just happens to also
 *  carry the "B" label restriction, a legality concern unrelated to
 *  layout); `DoubleCityHub`/`NewYorkHub` share "DoubleCity" for the
 *  identical reason on the two-node side. */
function archetypeForTerrain(terrain: TerrainType): HexArchetype {
  switch (terrain) {
    case "MajorCityHub":
    case "BostonHub":
      return "SingleCity";
    case "DoubleCityHub":
    case "NewYorkHub":
      return "DoubleCity";
    case "SmallTown":
      return "SingleTown";
    case "DoubleTown":
      return "DoubleTown";
    default:
      return "Plain";
  }
}

/** Classifies hex `(q, r)` into its rendering archetype. A laid tile's REAL
 *  current terrain wins when one exists (via `TILE_CATALOG_BY_ID`, the same
 *  lookup every other laid-tile-aware pass in this file already uses);
 *  otherwise falls back to the hex's own static pre-printed category --
 *  OO membership, town designation, city designation, or a real GRAY hex's
 *  marker kind. Every branch here reads a STRUCTURAL field (a Set
 *  membership test, an enum tag, an array length) rather than comparing a
 *  name/label string, so adding a new hex to any of the underlying data
 *  tables classifies correctly with zero changes to this function. */
function archetypeForHex(mapGrid: MapGridResponse, q: number, r: number): HexArchetype {
  const laidTile = mapGrid.tiles.find((tile) => tile.q === q && tile.r === r);
  if (laidTile) {
    const catalogEntry = TILE_CATALOG_BY_ID.get(laidTile.tile_id);
    if (catalogEntry) return archetypeForTerrain(catalogEntry.terrain);
  }
  const boardHex = STATIC_BOARD_HEXES.find((hex) => hex.q === q && hex.r === r);
  if (boardHex) {
    if (YELLOW_OO_HEXES.has(boardHex.label)) return "DoubleCity";
    if (boardHex.townDesignation === "double") return "DoubleTown";
    if (boardHex.townDesignation === "single") return "SingleTown";
    if (boardHex.cityDesignation) return "SingleCity";
    const grayTrack = GRAY_HEXES[boardHex.label];
    if (grayTrack?.marker === "city") return "SingleCity";
    if (grayTrack?.marker === "town") return "SingleTown";
  }
  // A landmark's un-laid archetype is read off the STRUCTURE of its own
  // real printed track (`LANDMARK_TRACKS`, design note #6b's sourced data):
  // two independent one-edge stub segments means two independent stations
  // (New York's real "one hex, two disconnected stations" design) --
  // "DoubleCity" -- while any other segment count means one shared station
  // -- "SingleCity". This is a STRUCTURAL read (segment count), not a name
  // check: a hypothetical future landmark would classify correctly the
  // same way without touching this function, purely from how many
  // segments ITS OWN `LANDMARK_TRACKS` entry happens to have.
  const landmark = LANDMARK_HEXES.find((entry) => entry.q === q && entry.r === r);
  if (landmark) {
    const segments = LANDMARK_TRACKS[landmark.name] ?? [];
    return segments.length >= 2 ? "DoubleCity" : "SingleCity";
  }
  return "Plain";
}

/* ------------------------------------------------------------------ */
/* 13-Slot Perimeter Anchor System (design note #70)                  */
/* ------------------------------------------------------------------ */
//
// A single pointy-topped-hex coordinate system every label/badge placement
// pass in this file resolves its anchor point through, instead of each
// pass hand-deriving its own corner/edge math (the old `BADGE_CORNERS`
// tiered search, the fixed-literal corner in `drawRestrictionBadge`, the
// fixed lower-third offset for terrain cost labels, the fixed upper-left
// `singleNodeNameplateAnchor`). Thirteen slots per hex:
//   - Slot 0: hex center.
//   - Slots 1-6: the six EDGE MIDPOINTS, in clockwise order starting from
//     Top-Right (NE): Top-Right, Right, Bottom-Right, Bottom-Left, Left,
//     Top-Left. "Right"/"Left" (slots 2/5) are the two VERTICAL edges --
//     this file's hexes are already pointy-topped (see `axialToPixel`/
//     `edgeAngleRad`/`cornerAngleRad`'s own geometry: edge 0/E and edge
//     3/W sit at screen-horizontal, corner 2 and corner 5 sit at true
//     screen-top/bottom -- unchanged by this pass, just made explicit
//     here as this system's own documented baseline).
//   - Slots 7-12: the six CORNER VERTICES, in clockwise order starting
//     from the Top Point: Top Point, Upper-Right, Lower-Right, Bottom
//     Point, Lower-Left, Upper-Left.
// `EDGE_SLOT_TO_EDGE_INDEX`/`CORNER_SLOT_TO_CORNER_INDEX` below are the
// fixed permutation tables translating this slot numbering onto the
// file's own pre-existing `edgeAngleRad`/`cornerAngleRad` index
// conventions (0=E/1=NE/2=NW/3=W/4=SW/5=SE for edges; corner `i` at
// `(30 - 60*i)` degrees) -- verified by hand against every one of
// `BADGE_CORNERS`' four existing `guardEdges` entries before this system
// replaced it (see `drawValueBadge`'s own call site below).
//
// SCOPE: this system positions LABELS/BADGES ONLY -- nameplates, tile
// upgrade-restriction badges, terrain cost labels, and revenue badges.
// It does NOT touch backend state rules or station/token node coordinates
// (`stationMarkerPoint`, `twoNodePositions`, `doubleNodeOffset`,
// `drawBadgeShape`'s own shape geometry) -- those keep their own existing,
// independently-tuned formulas, entirely untouched by this pass.

const HEX_SLOT_COUNT = 13;

const EDGE_SLOT_TO_EDGE_INDEX: readonly number[] = [1, 0, 5, 4, 3, 2];
// slot 1 = Top-Right (edge 1/NE)      slot 4 = Bottom-Left (edge 4/SW)
// slot 2 = Right/Vertical (edge 0/E)  slot 5 = Left/Vertical (edge 3/W)
// slot 3 = Bottom-Right (edge 5/SE)   slot 6 = Top-Left (edge 2/NW)

const CORNER_SLOT_TO_CORNER_INDEX: readonly number[] = [2, 1, 0, 5, 4, 3];
// slot 7 = Top Point (corner 2)       slot 10 = Bottom Point (corner 5)
// slot 8 = Upper-Right (corner 1)     slot 11 = Lower-Left (corner 4)
// slot 9 = Lower-Right (corner 0)     slot 12 = Upper-Left (corner 3)

/** The actual pixel point for `slot` (0-12) -- slot 0 at raw `center`,
 *  slots 1-6 at `apothem` distance (an edge midpoint), slots 7-12 at the
 *  full `size` corner-vertex distance. Most label passes DON'T draw
 *  exactly here (a revenue badge still uses its own tuned `size * 0.65`
 *  mid-radius offset -- design note #109, was `0.44`, then briefly `0.38`,
 *  then `0.55` -- a nameplate its own `-0.25/-0.35` wedge, etc. -- see
 *  each call site) -- this gives the raw geometric reference point; `hexSlotDirection`
 *  gives just the unit direction for callers that want to scale it
 *  themselves. */
function hexSlotPoint(center: { x: number; y: number }, size: number, slot: number): { x: number; y: number } {
  if (slot === 0) return center;
  if (slot >= 1 && slot <= 6) {
    const apothem = size * (Math.sqrt(3) / 2);
    return pointOnCircle(center, apothem, edgeAngleRad(EDGE_SLOT_TO_EDGE_INDEX[slot - 1]));
  }
  return pointOnCircle(center, size, cornerAngleRad(CORNER_SLOT_TO_CORNER_INDEX[slot - 7]));
}

/** The unit direction vector for `slot` (0-12) -- `{x:0,y:0}` for slot 0
 *  (center has no direction), otherwise `hexSlotPoint` evaluated at
 *  `size=1` around the origin. Lets a caller keep its own existing
 *  magnitude/offset convention (e.g. `drawValueBadge`'s `size * 0.65`
 *  mid-radius (design note #109, was `0.44`, then briefly `0.38`, then
 *  `0.55`), `singleNodeNameplateAnchor`'s `-0.25/-0.35` wedge) while
 *  still picking WHICH of the 13 directions to use via this system's
 *  occupancy-aware slot selection. */
function hexSlotDirection(slot: number): { x: number; y: number } {
  if (slot === 0) return { x: 0, y: 0 };
  return hexSlotPoint({ x: 0, y: 0 }, 1, slot);
}

/** The two edge indices (this file's own 0-5 convention) that flank corner
 *  slot `slot` (7-12) -- e.g. corner slot 12 (Upper-Left, corner index 3)
 *  is flanked by edge 2 (NW) and edge 3 (W). Verified against every one of
 *  the old `BADGE_CORNERS` table's four `guardEdges` entries before that
 *  table was replaced by this system (lower-left -> `[3,4]`, lower-right
 *  -> `[5,0]`, upper-left -> `[2,3]`, upper-right -> `[1,0]`, all
 *  reproduced exactly by `(cornerIndex + 5) % 6, cornerIndex`). */
function cornerSlotGuardEdges(slot: number): readonly [number, number] {
  const cornerIndex = CORNER_SLOT_TO_CORNER_INDEX[slot - 7];
  return [(cornerIndex + 5) % 6, cornerIndex];
}

/** Which of the 13 slots does `edgeIndices` (this file's own 0-5
 *  convention -- either a hex's real LIVE track edges, or, reused for the
 *  "prefer a permanently dead edge" tier below, its `deadEdgesAt` edges)
 *  make unusable: an edge-midpoint slot (1-6) is unusable if that exact
 *  edge is in the set; a corner slot (7-12) is unusable if EITHER of its
 *  two `cornerSlotGuardEdges` is (a curve between adjacent live edges
 *  bows toward the corner between them). `centerBlocked` marks slot 0
 *  directly -- computed by the caller (`hexBlockedSlots` below) from
 *  archetype + live-edge occupancy, not from this function, since "is the
 *  center occupied" isn't a pure function of an edge set the way the
 *  other 12 slots are (see that function's own doc comment). */
function slotsBlockedByEdges(edgeIndices: readonly number[], centerBlocked: boolean): Set<number> {
  const blocked = new Set<number>();
  if (centerBlocked) blocked.add(0);
  const edgeSet = new Set(edgeIndices);
  for (let slot = 1; slot <= 6; slot++) {
    if (edgeSet.has(EDGE_SLOT_TO_EDGE_INDEX[slot - 1])) blocked.add(slot);
  }
  for (let slot = 7; slot <= 12; slot++) {
    const [a, b] = cornerSlotGuardEdges(slot);
    if (edgeSet.has(a) || edgeSet.has(b)) blocked.add(slot);
  }
  return blocked;
}

/** This hex's real, structural live track edges (this file's own 0-5
 *  convention), from whichever real source actually applies -- a laid
 *  tile's own rotated `connections` mask, a real `GRAY_HEXES`/
 *  `OFFBOARD_TRACKS` printed-track entry, or a landmark's `LANDMARK_TRACKS`
 *  segments flattened -- mirroring `archetypeForHex`'s own exact
 *  fallback order so the two functions always agree on which hex they're
 *  describing. Empty for a hex with no real track at all (a blank
 *  designation, or an unlaid Mountain/River terrain hex). */
function liveEdgesForHex(mapGrid: MapGridResponse, q: number, r: number): number[] {
  const laidTile = mapGrid.tiles.find((tile) => tile.q === q && tile.r === r);
  if (laidTile) {
    const catalogEntry = TILE_CATALOG_BY_ID.get(laidTile.tile_id);
    if (catalogEntry) return liveEdges(rotateConnections(catalogEntry.connections, laidTile.orientation));
  }
  const boardHex = STATIC_BOARD_HEXES.find((hex) => hex.q === q && hex.r === r);
  if (boardHex) {
    const grayTrack = GRAY_HEXES[boardHex.label];
    if (grayTrack) return [...grayTrack.edges];
    const offboardEdges = OFFBOARD_TRACKS[boardHex.label];
    if (offboardEdges) return [...offboardEdges];
  }
  const landmark = LANDMARK_HEXES.find((entry) => entry.q === q && entry.r === r);
  if (landmark) {
    const segments = LANDMARK_TRACKS[landmark.name] ?? [];
    return segments.flatMap((segment) => [...segment.edges]);
  }
  return [];
}

/** The full blocked-slot set for hex `(q, r)` -- Requirement 3's "mark
 *  Slot 0 BLOCKED if a track spline or single-city station circle
 *  occupies (0,0); mark perimeter slots near active track BLOCKED"
 *  evaluated for real. Center is occupied by a `SingleCity`/`SingleTown`
 *  archetype's own always-central station/dit circle (`drawStationCircle`/
 *  `drawDitMarker` both draw AT `center` for these two archetypes,
 *  unconditionally), OR by ordinary track passing through it (any hex
 *  with live edges that ISN'T `DoubleCity`/`DoubleTown` -- those two
 *  archetypes route their track to their own off-center station nodes
 *  instead, by construction, see `twoCityStationPoints`'s and design note
 *  #52's own "wrong to fan through one shared center point" reasoning --
 *  so a `DoubleCity`/`DoubleTown` hex's center is NEVER occupied,
 *  regardless of how many live edges it has, which is exactly why every
 *  OO/G19/double-town nameplate already renders dead-center). */
function hexBlockedSlots(mapGrid: MapGridResponse, q: number, r: number): Set<number> {
  const archetype = archetypeForHex(mapGrid, q, r);
  const edges = liveEdgesForHex(mapGrid, q, r);
  const isDoubleArchetype = archetype === "DoubleCity" || archetype === "DoubleTown";
  const centerBlocked =
    archetype === "SingleCity" || archetype === "SingleTown" || (edges.length > 0 && !isDoubleArchetype);
  return slotsBlockedByEdges(edges, centerBlocked);
}

/** Design note #104: each perimeter slot (1-12) sits at a fixed 30-degree
 *  increment around the hex -- edge slots at 0/60/120/180/240/300, corner
 *  slots at 30/90/150/210/270/330 (hand-derived from `hexSlotDirection`'s
 *  own `edgeAngleRad`/`cornerAngleRad` calls: `EDGE_SLOT_TO_EDGE_INDEX`/
 *  `CORNER_SLOT_TO_CORNER_INDEX` resolve to exactly this alternating
 *  edge/corner/edge/corner sequence, verified by hand for all twelve before
 *  writing this table). Slot 0 (center) has no angle -- it's a genuinely
 *  distinct location, not a point on the perimeter, so it's `undefined`
 *  here and always treated as angularly compatible with everything below. */
const SLOT_ANGLE_DEG: readonly (number | undefined)[] = [
  undefined, // slot 0: center
  300, // slot 1 (edge, NE)
  0, // slot 2 (edge, E)
  60, // slot 3 (edge, SE)
  120, // slot 4 (edge, SW)
  180, // slot 5 (edge, W)
  240, // slot 6 (edge, NW)
  270, // slot 7 (corner, Top Point)
  330, // slot 8 (corner, Upper-Right)
  30, // slot 9 (corner, Lower-Right)
  90, // slot 10 (corner, Bottom Point)
  150, // slot 11 (corner, Lower-Left)
  210, // slot 12 (corner, Upper-Left)
];

/** Design note #104: the minimum angular separation (degrees) this file now
 *  enforces between two claimed slots on the SAME hex, per explicit
 *  request -- e.g. Slot 10 (Bottom Point, 90 deg) and Slot 9 (Lower-Right
 *  corner, 30 deg) are only 60 deg apart and read as visually crowded
 *  together; Slot 10 and Slot 7 (Top Point, 270 deg, exactly opposite) or
 *  Slot 1 (edge, 300 deg, 150 deg away) read as cleanly separated. */
const MIN_SLOT_ANGULAR_SEPARATION_DEG = 120;

/** The shortest angular distance (0-180 degrees) between perimeter slots
 *  `a` and `b`. Slot 0 (center) has no angle (`SLOT_ANGLE_DEG[0]` is
 *  `undefined`) and is always treated as maximally separated from
 *  everything -- it's a distinct location, not a competing point on the
 *  same 30-degree ring, so it never counts as "crowding" a perimeter
 *  slot or vice versa. */
function slotAngularSeparationDeg(a: number, b: number): number {
  const angleA = SLOT_ANGLE_DEG[a];
  const angleB = SLOT_ANGLE_DEG[b];
  if (angleA === undefined || angleB === undefined) return 180;
  const diff = Math.abs(angleA - angleB) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/** Design note #104: which perimeter slots (1-12) are angularly too close
 *  (< `MIN_SLOT_ANGULAR_SEPARATION_DEG`) to any slot already in
 *  `claimedSlots` on this same hex -- i.e., slots that AREN'T literally
 *  already taken (`claimHexSlot`'s own exact-slot check already prevents
 *  that) but would still visually crowd an already-placed nameplate/badge/
 *  icon. Consulted by `pickHexSlot` as an extra soft-avoid layer, on top
 *  of (not replacing) the real track/claim blocking it already does. Slot
 *  0 (center) is never returned here (it doesn't compete with perimeter
 *  slots -- see `slotAngularSeparationDeg`) and an empty `claimedSlots`
 *  (the overwhelming majority of hexes -- at most one or two features)
 *  yields an empty result, so this is a no-op until a hex is genuinely
 *  crowded enough to have multiple claims already on it. */
function angularConflictSlots(claimedSlots: ReadonlySet<number>): Set<number> {
  const conflicts = new Set<number>();
  // `forEach`, not `for...of` -- iterating a `Set` directly requires
  // `--downlevelIteration`/an ES2015+ target, which this project's `es5`
  // target doesn't have (`tsc` TS2802), same reasoning `claimHexSlot`
  // itself already documents at its own `combinedBlocked` construction.
  claimedSlots.forEach((claimedSlot) => {
    if (claimedSlot === 0) return;
    for (let slot = 1; slot <= 12; slot++) {
      if (slotAngularSeparationDeg(slot, claimedSlot) < MIN_SLOT_ANGULAR_SEPARATION_DEG) {
        conflicts.add(slot);
      }
    }
  });
  return conflicts;
}

/** Runs the real 6-tier preference search (see `pickHexSlot`'s own doc
 *  comment for the tier list) STRICTLY within `candidates`, in the order
 *  given, returning `undefined` if nothing in `candidates` is even open.
 *  Factored out by design note #106 so `pickHexSlot` can run this once
 *  against a caller's real, curated preference list and only fall through
 *  to a second, separate run against the "no real preference" fallback
 *  tail if EVERY candidate in the real list is unusable -- see that design
 *  note for why the two lists must never be searched as one flat scan. */
function pickFromCandidates(
  candidates: readonly number[],
  blockedSlots: ReadonlySet<number>,
  deadEdgeSlots: ReadonlySet<number>,
  angularConflict: ReadonlySet<number>,
): number | undefined {
  const softBlocked = new Set<number>();
  blockedSlots.forEach((s) => softBlocked.add(s));
  angularConflict.forEach((s) => softBlocked.add(s));
  return (
    candidates.find((slot) => !softBlocked.has(slot) && deadEdgeSlots.has(slot)) ??
    candidates.find((slot) => deadEdgeSlots.has(slot) && !angularConflict.has(slot)) ??
    candidates.find((slot) => !softBlocked.has(slot)) ??
    candidates.find((slot) => !blockedSlots.has(slot) && deadEdgeSlots.has(slot)) ??
    candidates.find((slot) => deadEdgeSlots.has(slot)) ??
    candidates.find((slot) => !blockedSlots.has(slot))
  );
}

/** Picks the best slot from `candidateSlots` (a caller-supplied preference
 *  order -- e.g. corners-only for a badge, or every slot for a nameplate)
 *  using the same 4-tier preference `drawValueBadge`'s old bespoke
 *  `BADGE_CORNERS` search used (design note #39's "prefer a permanently
 *  dead edge over a merely not-currently-live one" reasoning, generalized
 *  past just badges to every slot-based placement in the file):
 *   1. Open AND adjacent to a permanently dead edge (`deadEdgeSlots`) --
 *      both no current collision risk AND a structural guarantee no
 *      FUTURE track can ever appear there either.
 *   2. Adjacent to a dead edge even if currently blocked by something
 *      else (a name label, say) -- still permanently track-safe.
 *   3. Simply open (not in `blockedSlots`).
 *   4. Nothing matched -- the first candidate anyway, the closest this
 *      model can get without full custom per-hex placement.
 *
 *  Design note #104: `angularConflict` (this same hex's already-claimed
 *  slots run through `angularConflictSlots` -- see that function's own doc
 *  comment) is folded into tiers 1-3 as an EXTRA soft-avoid layer, tried
 *  FIRST: a slot within `MIN_SLOT_ANGULAR_SEPARATION_DEG` of an existing
 *  claim on this hex is treated the same as a blocked one for this first
 *  pass, so two features on the same crowded hex land genuinely spread out
 *  rather than merely non-overlapping. If NO candidate can satisfy both
 *  real-collision-avoidance and angular separation at once, this
 *  degrades to the original (pre-#104) 4-tier search below, ignoring
 *  angular spacing -- a genuinely packed hex still gets a real,
 *  collision-avoiding slot rather than none; angular crowding there is
 *  the lesser evil.
 *
 *  Design note #106: reported via D6 -- a blank hex with a plain terrain
 *  cost badge and NOTHING blocking its actual first-choice preference
 *  (Vertex 3/slot10) still rendered at Edge 5/slot6 instead. Root cause:
 *  `claimHexSlot` used to pre-merge the caller's real preference list with
 *  `extendSlotPreference`'s "no real preference, last resort" fallback
 *  tail into ONE combined list before calling this function, and tiers 1-2
 *  above (the dead-edge tiers) scanned that WHOLE combined list -- so a
 *  low-priority fallback-tail slot that merely happened to sit next to a
 *  dead edge could leapfrog a genuinely open, actually-preferred PRIMARY
 *  slot that had no dead-edge adjacency of its own. `candidateSlots` here
 *  is now ONLY the caller's real preference list (never pre-extended);
 *  `fallbackTail` is searched, with this exact same tier order, ONLY once
 *  every entry in `candidateSlots` has been tried and failed -- so the
 *  fallback tail can never outrank an available primary-preference slot,
 *  dead-edge-adjacent or not. */
function pickHexSlot(
  candidateSlots: readonly number[],
  blockedSlots: ReadonlySet<number>,
  deadEdgeSlots: ReadonlySet<number>,
  angularConflict: ReadonlySet<number> = new Set(),
  fallbackTail: readonly number[] = [],
): number {
  return (
    pickFromCandidates(candidateSlots, blockedSlots, deadEdgeSlots, angularConflict) ??
    pickFromCandidates(fallbackTail, blockedSlots, deadEdgeSlots, angularConflict) ??
    candidateSlots[0]
  );
}

/** Design note #72: computes a feature's own short, hand-picked preference
 *  order (e.g. `BADGE_SLOT_PREFERENCE`'s four corners) a fallback TAIL --
 *  every OTHER slot in `pool` (default: all twelve non-center slots, 1-12)
 *  not already in `primary`, in a fixed ascending order -- so `pickHexSlot`
 *  always has somewhere else to look once a hex's own few "ideal"
 *  candidates are all blocked or already claimed by another feature,
 *  rather than falling all the way through to its own last-tier "first
 *  candidate anyway" and silently drawing on top of live track (or, post-
 *  `claimHexSlot`, on top of another label). Order among the fallback tail
 *  doesn't encode any real preference -- by the time a search reaches it,
 *  every genuinely-preferred slot is already unavailable, so any
 *  remaining open one is an equally acceptable last resort. A caller whose
 *  rendering only knows how to place at a CORNER passes `CORNER_SLOTS` as
 *  `pool` so its fallback tail can never hand back an edge slot it can't
 *  actually draw at.
 *
 *  Design note #105: `drawRestrictionBadge` was this constant's one real
 *  consumer (it used to index `CORNER_SLOT_TO_CORNER_INDEX[slot - 7]` and
 *  had no edge-slot rendering path) -- now generalized to render at ANY
 *  slot via `hexSlotDirection` (per direct request, "then check edges"),
 *  so it no longer passes this pool and nothing else in the file does
 *  either. Left defined, unused, rather than deleted -- this file's own
 *  established convention (see `nameplateBoxFillFor`/`NAMEPLATE_BOX_FILL_*`,
 *  design note #78a) for a constant a past pass needed but a later one
 *  superseded, kept as a documented historical record instead of a silent
 *  deletion.
 *
 *  Design note #106: RENAMED conceptually (kept the same identifier, one
 *  call site) from "extend the primary list with a tail" to "compute the
 *  tail by itself" -- returns ONLY the fallback slots now, not
 *  `[...primary, ...rest]`. `claimHexSlot` used to hand `pickHexSlot` the
 *  pre-concatenated result of this function; now it hands `pickHexSlot`
 *  the caller's real `candidateSlots` and this function's tail as two
 *  SEPARATE arguments -- see `pickHexSlot`'s own design note #106 comment
 *  for why keeping them apart matters. */
const CORNER_SLOTS: readonly number[] = [7, 8, 9, 10, 11, 12];

function extendSlotPreference(
  primary: readonly number[],
  pool: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
): readonly number[] {
  const rest: number[] = [];
  for (const slot of pool) {
    if (!primary.includes(slot)) rest.push(slot);
  }
  return rest;
}

/** Design note #72: CROSS-PASS SLOT CLAIMING. Reported via screenshot: on
 *  New York (G19), the revenue badge, the terrain-cost label, and the
 *  terrain icon all rendered stacked on top of each other at the same
 *  corner. Root cause -- every label/badge/icon pass in the file called
 *  `pickHexSlot` independently, each blind to what any OTHER pass had
 *  already drawn on the SAME hex; harmless as long as no two passes' own
 *  preference lists ever favored the same slot, but G19's two real stub
 *  track edges block four of its six corners, leaving only two open --
 *  and the badge, cost-label, and icon passes all independently picked
 *  the SAME one of those two.
 *
 *  `claimed` is one `Map<"q,r", Set<slot>>` a caller creates ONCE per
 *  render and threads through every slot-picking pass for that render
 *  (icon, restriction badge, terrain-cost label, value badge) in their
 *  existing draw order. Each call here unions its own hex's
 *  already-claimed slots into `blockedSlots` before picking (so it never
 *  re-picks a slot a prior pass already used on this same hex), then
 *  records whichever slot it lands on so the NEXT pass avoids it too.
 *  Combined with `extendSlotPreference`, a pass whose own short preference
 *  list is entirely taken falls through to any other still-open slot on
 *  the hex rather than colliding -- the common case (a hex with only one
 *  or two of these features) is completely unaffected, since `claimed`
 *  starts empty for every hex and only a genuinely crowded landmark hex
 *  like G19 ever reaches the fallback tail.
 *
 *  Design note #104: now ALSO computes `angularConflictSlots(alreadyClaimed)`
 *  and passes it through to `pickHexSlot` as that function's new
 *  `angularConflict` parameter -- so a hex with multiple claims doesn't
 *  just avoid re-picking the exact same slot (this function's original
 *  job), it also steers new claims at least `MIN_SLOT_ANGULAR_SEPARATION_DEG`
 *  away from every slot already claimed on that same hex, with the same
 *  graceful degrade `pickHexSlot` itself documents.
 *
 *  Design note #106: no longer pre-merges `candidateSlots` with its
 *  fallback tail before calling `pickHexSlot` -- passes them as two
 *  separate arguments instead, so `pickHexSlot` can search the real
 *  preference list to exhaustion before ever touching the tail. See
 *  `pickHexSlot`'s own design note #106 comment for the bug this fixes. */
function claimHexSlot(
  claimed: Map<string, Set<number>>,
  q: number,
  r: number,
  candidateSlots: readonly number[],
  blockedSlots: ReadonlySet<number>,
  deadEdgeSlots: ReadonlySet<number>,
  // Design note #72: restricts the fallback tail (see `extendSlotPreference`)
  // to a specific pool of slots -- pass `CORNER_SLOTS` for a caller that can
  // only ever render at a corner. Defaults to every non-center slot.
  pool?: readonly number[],
): number {
  const key = `${q},${r}`;
  const alreadyClaimed = claimed.get(key) ?? new Set<number>();
  // Built via `forEach`, not `[...blockedSlots, ...alreadyClaimed]` --
  // spreading a `Set` requires `--downlevelIteration`/an ES2015+ target,
  // which this project's `es5` target doesn't have (`tsc` TS2802).
  const combinedBlocked = new Set<number>();
  blockedSlots.forEach((s) => combinedBlocked.add(s));
  alreadyClaimed.forEach((s) => combinedBlocked.add(s));
  const angularConflict = angularConflictSlots(alreadyClaimed);
  const fallbackTail = extendSlotPreference(candidateSlots, pool);
  const slot = pickHexSlot(candidateSlots, combinedBlocked, deadEdgeSlots, angularConflict, fallbackTail);
  alreadyClaimed.add(slot);
  claimed.set(key, alreadyClaimed);
  return slot;
}

/** Design note #106: per-hex EXPLICIT slot overrides for the small set of
 *  named hexes where a direct request asked for a specific canonical
 *  18xx.games-style vertex/edge for one particular claim pass, rather than
 *  a change to that pass's board-wide generic preference order (which
 *  would ripple into every other hex sharing that pass, most of which
 *  weren't reported as wrong). Keyed by `"q,r"` -- this file's own
 *  established axial-coordinate map-key convention, already used
 *  identically by `claimed` itself just above -- then by which of the four
 *  claim passes (`nameplate`/`terrain`/`revenue`/`restriction`) the
 *  override applies to. Consulted via `withSlotOverride` below, which
 *  PREPENDS the override slot onto that pass's own normal preference list
 *  rather than replacing it outright -- so the override is only ever tried
 *  FIRST, and still runs through `claimHexSlot`'s full normal
 *  blocked/dead-edge/angular-conflict/already-claimed-on-this-hex safety
 *  checks (and therefore still has the pass's own real preference list, in
 *  its own order, as a graceful fallback tail if the requested slot turns
 *  out to be genuinely occupied by real printed track or a higher-priority
 *  claim). A hex/pass pair absent here is entirely unaffected.
 *
 *  F6 (Cleveland, 0,5) / A19 (Montreal, 9,0): revenue badge -> Edge 1/slot2
 *  -- reported sitting on Vertex 5 (F6, overlapping the nameplate) and
 *  drifting onto the track spline (A19) despite ample open space, with a
 *  guess that Edge 2/slot3 would be clear. HAND-VERIFIED against
 *  `GRAY_HEXES`' real edges for both (`{ edges: [4, 5] }` for each): slot3
 *  is actually BLOCKED (its guard edge is internal edge 5, one of these two
 *  hexes' own real live edges) -- placing the badge there would put it
 *  directly on top of the real printed track spline, the exact problem
 *  being reported, not a fix for it. Edge 1/slot2 is the nearest slot
 *  that's both a genuine EDGE (matching the request's own "Edge N"
 *  framing) and fully clear of `{4, 5}`'s two guard-edge pairs, and sits
 *  90 degrees from the nameplate's own slot7/Top claim -- the widest
 *  angular separation actually achievable here, since every slot in the
 *  bottom half of both hexes (3/4/9/10/11) is real-track-blocked.
 *  `BADGE_SLOT_PREFERENCE` only ever offers corners plus two FAR edges
 *  (design note #76), which doesn't include either Edge 1 or Edge 2.
 *  H12 (Altoona, 2,7): nameplate -> Vertex 3/slot10 (was sitting on the
 *  PRR reservation marker's curved track spline at its old corner) AND
 *  revenue badge -> Vertex 0/slot7 (the two were reported interfering with
 *  each other once the nameplate moved) -- both HAND-VERIFIED clear of
 *  Altoona's real `{ edges: [0, 3] }`.
 *  J14 (Washington, 2,9): nameplate -> Vertex 0/slot7, terrain icon+cost
 *  badge -> Vertex 2/slot9 (design note #110) -- both trivially achievable,
 *  Washington has no real printed track at all (a blank `cityDesignation`
 *  hex, same as Providence below).
 *  I15 (Baltimore, 3,8): nameplate -> Vertex 0/slot7 (design note #110,
 *  achievable, clear of Baltimore's real `{ edges: [0, 4] }`), revenue
 *  badge -> Vertex 2/slot9 (HAND-VERIFIED blocked -- Vertex 2's guard edge
 *  0 is one of Baltimore's own two real live edges -- degrades to its own
 *  normal order, landing at Edge 2/slot3 once the nameplate's Vertex 0
 *  claim also angularly rules out the two corners nearer it), restriction
 *  badge ("B") -> Edge 4/slot5 (HAND-VERIFIED open; angularly conflicts
 *  with both the nameplate and revenue badge's own claims by this point,
 *  but real-collision-avoidance still holds and the degrade search finds
 *  it anyway).
 *  G19 (New York, 6,6): terrain icon+cost badge -> Vertex 2/slot9 (design
 *  note #110 CORRECTION -- New York DOES have a real terrain badge here,
 *  see design note #71; an earlier pass incorrectly concluded otherwise by
 *  only checking `LANDMARK_HEXES`, missing that `STATIC_BOARD_HEXES` ALSO
 *  carries a separate `q:6,r:6` entry, `{ type: "River", printedColor:
 *  "Yellow" }`, specifically for this). Revenue badge -> Edge 4/slot5,
 *  restriction badge -> Edge 5/slot6 (design note #114 -- both HAND-
 *  VERIFIED genuinely open: neither slot's guard edge is one of New York's
 *  two real live edges, `{ edges: [1, 4] }`, so both resolve directly with
 *  no degrade needed, unlike the Vertex 1/Vertex 5 corners #106/#110 tried
 *  first). No `nameplate` entry: a DoubleCityHub nameplate
 *  already always renders dead-center by this file's own existing,
 *  unrelated design (see `doubleNodeNameplateAnchor`/its callers, and note
 *  it doesn't even call `claimHexSlot` -- it draws straight at `center`),
 *  matching the requested "nameplate is center" as-is.
 *  F22 (Providence, 8,5): nameplate -> Vertex 0/slot7, terrain icon+cost
 *  badge -> Vertex 2/slot9 -- both trivially achievable, Providence has no
 *  real printed track at all (a blank `cityDesignation` hex).
 *  E23 (Boston, 9,4): nameplate -> Vertex 3/slot10 (HAND-VERIFIED blocked
 *  by Boston's real SE stub, edge 5 -- degrades to Vertex 4/slot11, the
 *  nearest open corner; per direct request, acknowledged as unavoidable --
 *  "this nameplate will intersect something no matter where it is"),
 *  revenue badge -> Vertex 5/slot12 (design note #110: CHANGED from the
 *  originally-requested Vertex 0/slot7, which is also blocked -- by
 *  Boston's real NE stub, edge 1 -- to the newly-requested Vertex 5, which
 *  IS open; see `HEX_SLOT_RESERVE` for why the nameplate's own fallback
 *  search doesn't grab this slot first despite running earlier). No
 *  `restriction` entry anymore (design note #110 removed it) -- the "B"
 *  badge's own explicit Vertex 5 request from the PRIOR pass is superseded
 *  by this pass's revenue badge now wanting that exact slot instead;
 *  restriction has no override of its own this round and simply takes
 *  whatever its normal preference order resolves to once nameplate/revenue
 *  have claimed theirs (Edge 1/slot2 today).
 *  H18 (Philadelphia & Trenton, 5,7): restriction badge ("OO") -> Vertex
 *  5/slot12 (design note #112) -- the ONE `YELLOW_OO_HEXES` entry that
 *  actually needed this: H18 is the only one of the four bordering the
 *  board's own edge (one real dead edge, its east side), and that dead
 *  edge's two guard corners are Vertex 1/slot8 and Vertex 2/slot9 --
 *  `RESTRICTION_SLOT_PREFERENCE_DOUBLE_CITY`'s own tier 1 (design note
 *  #39/#70's "prefer a dead edge" rule) matched Vertex 1 before ever
 *  reaching Vertex 5 (first in the list, genuinely open, but not itself
 *  dead-edge-adjacent) -- the SAME leapfrog bug #111 fixed for explicit
 *  overrides, this time surfacing in the plain, non-override preference
 *  list on a hex whose geometry happens to trigger it. The other three OO
 *  hexes (E5, D10, E11) are all fully interior with zero dead edges, so
 *  their tier 1 never matches anything and they fall straight to tier 3's
 *  first-genuinely-open-slot check, landing on Vertex 5 correctly without
 *  needing an override at all -- confirmed by hand for all three before
 *  concluding H18 was the outlier, not a board-wide bug.
 *  B10 (Barrie, 4,1): nameplate -> Vertex 0/slot7 (design note #119) --
 *  reported rendering at Vertex 5/slot12 instead (this blank
 *  `cityDesignation` hex's normal preference-list default, same shape as
 *  Washington/Providence before THEIR nameplate overrides above); Vertex
 *  0/slot7 is trivially open, no real printed track on this hex at all.
 *  G19 (New York, 6,6): revenue badge and restriction badge SWAPPED
 *  (design note #120) -- previously `{ revenue: 5, terrain: 9,
 *  restriction: 6 }` per design note #114 (revenue at Edge 4/slot5,
 *  restriction at Edge 5/slot6); now `{ revenue: 6, terrain: 9,
 *  restriction: 5 }`, putting revenue at Edge 5/slot6 and restriction at
 *  Edge 4/slot5 -- the same two already-verified-open slots from #114,
 *  just trading which badge sits in which.
 *  F16 (Scranton, 5,5): nameplate -> Vertex 0/slot7, terrain icon+cost
 *  badge -> Vertex 2/slot9 (design note #123, per explicit request) --
 *  both HAND-VERIFIED open: F16 has no real printed track (a blank
 *  `cityDesignation` hex, same shape as Toledo/Providence/Washington
 *  above), so neither slot's guard edge can ever be blocked by real
 *  track here. */
const HEX_SLOT_OVERRIDE: Readonly<
  Record<string, { nameplate?: number; terrain?: number; revenue?: number; restriction?: number }>
> = {
  "0,5": { revenue: 2 }, // F6 Cleveland
  "9,0": { revenue: 2 }, // A19 Montreal
  "2,7": { nameplate: 10, revenue: 7 }, // H12 Altoona
  "2,9": { nameplate: 7, terrain: 9 }, // J14 Washington
  "3,8": { nameplate: 7, revenue: 9, restriction: 5 }, // I15 Baltimore
  "6,6": { revenue: 6, terrain: 9, restriction: 5 }, // G19 New York (design note #120 -- swapped from #114's revenue:5/restriction:6)
  "8,5": { nameplate: 7, terrain: 9 }, // F22 Providence
  "9,4": { revenue: 12, nameplate: 10 }, // E23 Boston
  "5,7": { restriction: 12 }, // H18 Philadelphia & Trenton (design note #112)
  "4,1": { nameplate: 7 }, // B10 Barrie (design note #119)
  "5,5": { nameplate: 7, terrain: 9 }, // F16 Scranton (design note #123)
};

/** Design note #111 SUPERSEDED THIS FUNCTION -- see that note and
 *  `claimHexSlotPreferring` below for why. Left defined, unused, per this
 *  file's own "don't delete superseded constants" convention: prepending
 *  the override onto `preference` and running the RESULT through
 *  `pickHexSlot`'s normal tiered search let a LATER, merely dead-edge-
 *  adjacent slot elsewhere in that same list leapfrog the override itself
 *  whenever the override slot wasn't also dead-edge-adjacent -- the exact
 *  D6 bug design note #106 fixed for the primary-list/fallback-tail split,
 *  re-appearing one level up, inside a single already-combined list. */
function withSlotOverride(
  q: number,
  r: number,
  pass: "nameplate" | "terrain" | "revenue" | "restriction",
  preference: readonly number[],
): readonly number[] {
  const override = HEX_SLOT_OVERRIDE[`${q},${r}`]?.[pass];
  if (override === undefined) return preference;
  return [override, ...preference.filter((slot) => slot !== override)];
}

/** Design note #111: looks up `HEX_SLOT_OVERRIDE` for `(q, r)`/`pass`,
 *  returning `undefined` if there's no override OR if the override's own
 *  slot is `HEX_SLOT_RESERVE`d for a DIFFERENT pass on this same hex (an
 *  override should never fight a reservation -- see that table's own doc
 *  comment for why the reservation exists in the first place). Paired with
 *  `claimHexSlotPreferring`, NOT `withSlotOverride` above -- see that
 *  function's own doc comment for why prepending onto a preference list
 *  and running it through the normal tiered search was the wrong shape for
 *  an EXPLICIT, deliberate placement. */
function resolveSlotOverride(
  q: number,
  r: number,
  pass: "nameplate" | "terrain" | "revenue" | "restriction",
): number | undefined {
  const override = HEX_SLOT_OVERRIDE[`${q},${r}`]?.[pass];
  if (override === undefined) return undefined;
  const reserve = HEX_SLOT_RESERVE[`${q},${r}`];
  if (reserve && reserve.for !== pass && reserve.slot === override) return undefined;
  return override;
}

/** Design note #111: an EXPLICIT per-hex override (`HEX_SLOT_OVERRIDE`) is
 *  a deliberate, specific placement decision -- it should be honored
 *  whenever the slot is actually usable, and give way ONLY to a genuine
 *  collision (real printed track, or another pass that already claimed it
 *  this render), never to the normal preference-list tiers' OWN "prefer a
 *  permanently dead edge" heuristic (design note #39/#70), which exists to
 *  break ties among a list of otherwise-equally-acceptable candidates, not
 *  to outrank a slot the caller specifically asked for. Tries `preferredSlot`
 *  directly (bypassing `pickHexSlot`'s tiers and even angular-conflict
 *  soft-avoidance entirely -- an explicit request should win a mere
 *  angular-crowding tiebreak too); only falls through to the ordinary
 *  `claimHexSlot`/`pickHexSlot` tiered search over `candidateSlots` (the
 *  pass's own UNMODIFIED normal preference list, not prepended with
 *  anything) if `preferredSlot` is missing or genuinely blocked/claimed.
 *  Reported (J14/Washington): the override system's old shape
 *  (`withSlotOverride`, prepend-then-tier-search) let the nameplate's
 *  override (Vertex 0/slot7, genuinely open) lose to Vertex 1/slot8 purely
 *  because slot8 happened to sit next to Washington's one real dead edge
 *  (its own east board-boundary edge) -- exactly reproducing D6's original
 *  bug one level up. */
function claimHexSlotPreferring(
  claimed: Map<string, Set<number>>,
  q: number,
  r: number,
  preferredSlot: number | undefined,
  candidateSlots: readonly number[],
  blockedSlots: ReadonlySet<number>,
  deadEdgeSlots: ReadonlySet<number>,
  pool?: readonly number[],
): number {
  if (preferredSlot !== undefined) {
    const key = `${q},${r}`;
    const alreadyClaimed = claimed.get(key) ?? new Set<number>();
    if (!blockedSlots.has(preferredSlot) && !alreadyClaimed.has(preferredSlot)) {
      alreadyClaimed.add(preferredSlot);
      claimed.set(key, alreadyClaimed);
      return preferredSlot;
    }
  }
  return claimHexSlot(claimed, q, r, candidateSlots, blockedSlots, deadEdgeSlots, pool);
}

/** Design note #113: an EXPERIMENTAL, unconditional per-hex/per-pass slot
 *  force -- unlike `HEX_SLOT_OVERRIDE` (honored unless a real collision
 *  makes it genuinely unusable), a `HEX_SLOT_FORCE` entry always wins, no
 *  exceptions: no real-track-blocked check, no already-claimed-on-this-hex
 *  check, nothing. Exists specifically for "put it here so I can see how it
 *  looks, I don't care what it overlaps" requests, where the whole point is
 *  to bypass this file's collision-avoidance machinery on purpose rather
 *  than have it silently substitute a "safer" slot. Still RECORDS the claim
 *  in `claimedHexSlots` (so any OTHER pass on the same hex that doesn't
 *  have its own force still tries to avoid this slot, even though this
 *  pass itself doesn't care) -- only this one pass's own collision check is
 *  skipped, not every other pass's.
 *
 *  Kept as a SEPARATE table (rather than, say, an "ignoreCollisions" flag
 *  added onto `HEX_SLOT_OVERRIDE`) so the two stay visually and
 *  semantically distinct in this file -- an override is still a real,
 *  collision-respecting placement decision; a force is a deliberate,
 *  temporary "show me anyway" probe.
 *
 *  Design note #114: G19's own entry REMOVED -- the Vertex 1 force
 *  (revenue badge directly on New York's real NE track stub) was a one-off
 *  "let me see it" probe, and having seen it ("I see it is a problem
 *  there"), the follow-up moved on to a genuinely different, non-colliding
 *  pair of slots (Edge 4/Edge 5) via ordinary `HEX_SLOT_OVERRIDE` entries
 *  instead -- no force needed there, since both are actually open.
 *
 *  Design note #115: E23/Boston's nameplate FORCED to Vertex 3/slot10 --
 *  direct request, explicitly accepting the collision with Boston's own
 *  real SE track stub (`LANDMARK_TRACKS["Boston"]`'s `edges: [1, 5]`,
 *  guarded by edge 5) that's made this slot genuinely unusable for the
 *  nameplate ever since it was first requested back in design note #106
 *  (where it degraded to Vertex 4) -- the user's own suspicion that this
 *  was the dead-edge tier rule (design note #111/#112's bug) rather than a
 *  genuine track collision was checked and ruled out: Vertex 3's two guard
 *  edges are 4 and 5, and edge 5 IS one of Boston's two real live edges,
 *  so this was always a real collision, not a leapfrog bug -- forcing
 *  through it is the correct tool here, not another bug fix. */
const HEX_SLOT_FORCE: Readonly<
  Record<string, { nameplate?: number; terrain?: number; revenue?: number; restriction?: number }>
> = {
  "9,4": { nameplate: 10 }, // E23 Boston -- forced to Vertex 3, ignoring its real SE track stub
};

function claimHexSlotForced(claimed: Map<string, Set<number>>, q: number, r: number, slot: number): number {
  const key = `${q},${r}`;
  const alreadyClaimed = claimed.get(key) ?? new Set<number>();
  alreadyClaimed.add(slot);
  claimed.set(key, alreadyClaimed);
  return slot;
}

/** Design note #106: on a hex where ONE claim pass has a genuinely
 *  achievable explicit override on a slot, but an EARLIER-running pass
 *  (per the fixed nameplate > terrain > revenue > restriction order) would
 *  otherwise reach that same slot in its own graceful-degrade fallback
 *  search first -- it has no way to know a LATER pass has its own explicit
 *  claim on it. `HEX_SLOT_RESERVE` names the one slot on a hex that's
 *  reserved for one specific pass; `withSlotReserve` (used by every pass
 *  EXCEPT the reserved one) filters that slot out of its own candidate
 *  list entirely, so it's forced past it to its own next-best fallback
 *  instead of claiming it first purely by going first.
 *
 *  Design note #110: G19/New York added -- once New York's terrain badge
 *  correction (see `HEX_SLOT_OVERRIDE`'s own doc comment) claims Vertex
 *  2/slot9, the revenue badge's own fallback search (its requested Vertex
 *  1 being blocked) would otherwise land on Vertex 5/slot12 next -- exactly
 *  where the restriction badge's own explicit override needs to go.
 *  E23/Boston's own entry REPOINTED from `restriction` to `revenue`: the
 *  revenue badge's request changed (this same pass) from Vertex 0 (blocked)
 *  to Vertex 5 -- now revenue is the pass with the achievable claim on that
 *  slot, and it's the nameplate (running before it) whose own fallback
 *  search would otherwise reach Vertex 5 first and needs to be steered
 *  around it instead.
 *
 *  Design note #114: G19's own entry REMOVED -- its revenue and
 *  restriction badges moved to Edge 4/slot5 and Edge 5/slot6 respectively,
 *  neither of which any OTHER pass's own fallback search on this hex would
 *  ever reach (terrain's claim at Vertex 2/slot9 doesn't compete with
 *  either), so nothing needs steering away from them anymore. */
const HEX_SLOT_RESERVE: Readonly<
  Record<string, { for: "nameplate" | "terrain" | "revenue" | "restriction"; slot: number }>
> = {
  "9,4": { for: "revenue", slot: 12 }, // E23 Boston -- reserves Vertex 5 for the revenue badge
};

function withSlotReserve(
  q: number,
  r: number,
  pass: "nameplate" | "terrain" | "revenue" | "restriction",
  preference: readonly number[],
): readonly number[] {
  const reserve = HEX_SLOT_RESERVE[`${q},${r}`];
  if (!reserve || reserve.for === pass) return preference;
  return preference.filter((slot) => slot !== reserve.slot);
}

/** Archetype B/DoubleTown shared TWO-NODE offset (ORIGIN design note #55,
 *  magnitude/direction UPDATED from #54's `ooCityMarkerOffset`; node index
 *  convention fixed by #56; sole remaining outlier folded in by #57;
 *  REPLACED WHOLESALE by design note #73 -- see that note for why). THE ONE
 *  canonical coordinate helper for every two-node hex on the board. Node
 *  Index 0 = `center + this offset`; Node Index 1 = `center - this offset`,
 *  universally.
 *
 *  Design note #73: reported via a real 18xx.games reference screenshot of
 *  G19 -- the two node positions were sitting at roughly a hex VERTEX
 *  (#55's `(+0.43, -0.25)` diagonal resolves to an angle of -30.17 degrees,
 *  0.17 degrees off this file's own corner-1/`cornerAngleRad(1)` exactly),
 *  when the real board (and the user's own explicit instruction) puts each
 *  node on an EDGE MIDPOINT instead -- this file's edge 1 (NE, the user's
 *  own "Edge 0") for node 0, and edge 4 (SW, the user's own "Edge 3") for
 *  node 1. Edges 1 and 4 are exactly opposite (180 degrees apart:
 *  `edgeAngleRad(1) = -60`, `edgeAngleRad(4) = 120`), so a single delta
 *  vector applied as `center + delta`/`center - delta` still works exactly
 *  as before -- only the vector's own direction and magnitude changed, not
 *  `twoNodePositions`' `±` structure below.
 *
 *  MAGNITUDE: the true edge-1 midpoint sits at the full apothem
 *  (`size * sqrt(3)/2`, ~0.866 * size) from center -- placing a node's
 *  station circle (`drawStationCircle`'s own `size * 0.22` radius) exactly
 *  there would let roughly `0.22 * size` of it bleed straight through the
 *  hex's own printed border into the neighboring hex.
 *
 *  Design note #77: FURTHER pulled in, from #73's original `size * 0.58` to
 *  `size * 0.50`. Reported: at `0.58`, the station circle sat close enough
 *  to the edge (`0.58 + 0.22 = 0.80` against the `0.866` boundary, a bare
 *  `0.066 * size` clearance) that the short real track stub connecting the
 *  edge to the station -- the very thing this offset exists to keep
 *  visible, on G19 and any other double-node hex with real printed track --
 *  was nearly invisible. At `0.50`: `0.50 + 0.22 = 0.72`, a `0.146 * size`
 *  clearance, well over double the visible stub length, while the station
 *  is still unambiguously anchored to its own edge's midpoint (unchanged
 *  direction, only the distance out from center moved).
 *
 *  BOARD-WIDE, same as before: every double-node hex calls this exact
 *  function for its station-circle/town-dot coordinates -- the preprinted
 *  New York (G19) landmark (`stationMarkerPoint`/`drawLandmarkTrack`,
 *  design note #56 -- New York's real printed stub track terminates AT
 *  these coordinates, not at some independently-derived approximation of
 *  them), every unlaid OO hex (`drawOOCityMarkers`), every laid
 *  OO/`DoubleCityHub` tile #59/#64-#68 (`twoCityStationPoints`), every
 *  unlaid double-town-designated hex's dit markers, and every laid
 *  `DoubleTown` tile #6's dit markers. Every one of these moves together,
 *  by construction -- there is no per-hex override anywhere in the file.
 *  Kept as the low-level `(x, y)` delta primitive that `twoNodePositions`
 *  (design note #58, directly below) builds on -- every actual call site
 *  goes through `twoNodePositions` instead of hand-writing `center ±
 *  offset` itself. */
function doubleNodeOffset(size: number): { x: number; y: number } {
  const magnitude = size * 0.5;
  return pointOnCircle({ x: 0, y: 0 }, magnitude, edgeAngleRad(1));
}

/** THE single shared 2-node coordinate helper (design note #58) for every
 *  double-city and double-town feature on the board -- New York (G19), all
 *  five OO `DoubleCityHub` variants (laid and unlaid), and all three
 *  double-town hexes (laid `DoubleTown` tile #6 and the unlaid
 *  `townDesignation: "double"` marker pass). Returns a 2-tuple, `[node0,
 *  node1]`, so every call site indexes directly into the SAME array a
 *  feature's own city/town/segment index already uses (`cityGroups[0]`/
 *  `[1]`, `LANDMARK_TRACKS[...][0]`/`[1]`, a company's `city_index`) --
 *  index 0 is always the first slot (Top-Right/Northeast), index 1 is
 *  always the second slot (Bottom-Left/Southwest), with NO re-sorting, no
 *  sign-flipped arithmetic re-derived at each call site, and therefore no
 *  opportunity for a call site to accidentally swap which physical corner
 *  a given index lands on (the exact class of bug design note #56 fixed
 *  for G19 specifically -- this generalizes that fix so it can't recur at
 *  any OTHER call site either). Every 2-node feature on the board -- laid
 *  or unlaid, city or town -- calls this one function; none compute their
 *  own diagonal offset independently anymore. */
function twoNodePositions(
  center: { x: number; y: number },
  size: number,
): [{ x: number; y: number }, { x: number; y: number }] {
  const offset = doubleNodeOffset(size);
  return [
    { x: center.x + offset.x, y: center.y + offset.y }, // index 0: Top-Right / Northeast
    { x: center.x - offset.x, y: center.y - offset.y }, // index 1: Bottom-Left / Southwest
  ];
}

/** Archetype A/SingleTown shared nameplate anchor (design note #55's
 *  Upper-Left wedge default; DYNAMICALLY SLOT-AWARE by design note #70's
 *  13-Slot system): used for any hex with exactly ONE central station/dit
 *  node (a laid `MajorCityHub`/`BostonHub` tile, a real GRAY single-city
 *  hex, an ordinary white `cityDesignation` hex, a real GRAY single-town
 *  hex, or a blank `townDesignation: "single"` hex).
 *
 *  #55 anchored EVERY single-node hex at the identical fixed Upper-Left
 *  point regardless of what track that specific hex actually has -- fine
 *  for most of the board, but with no fallback at all for the hexes whose
 *  real printed track happens to run through that exact wedge. #70 makes
 *  the choice of WHICH open slot to use dynamic: `NAMEPLATE_SLOT_PREFERENCE`
 *  tries Upper-Left (slot 12) as ONE candidate; a hex that resolves there
 *  still renders at the EXACT same pixel as #55's original literal
 *  formula, via the `slot === 12` special case just below. Off that one
 *  slot, the SAME wedge magnitude (`size * hypot(0.25, 0.35)`, #55's own
 *  tuned "into the hex, not all the way to the corner" distance) is kept,
 *  just re-aimed along the chosen slot's own direction (`hexSlotDirection`)
 *  instead of #55's fixed literal `(-0.25, -0.35)` vector.
 *
 *  Design note #105: Upper-Left is no longer tried FIRST -- per direct
 *  request, `NAMEPLATE_SLOT_PREFERENCE` now leads with center (slot 0),
 *  then the top vertex (slot 7), then the bottom vertex (slot 10), so the
 *  "overwhelming majority renders byte-identical to #55" property this
 *  paragraph used to describe no longer holds; see that constant's own
 *  updated doc comment for the reasoning. */
// Design note #74: reordered -- Upper-Left (12) is still tried FIRST (the
// overwhelmingly common case renders byte-identical to before), but the
// BOTTOM VERTEX (10) moves to SECOND preference instead of second-to-last.
// Reported: on real gray connector hexes with heavy pre-printed track
// fanning out from center (Fall River/F24, Atlantic City/I19), every upper
// corner ends up blocked, and the OLD order fell through six EDGE slots
// first -- each one sitting right where a track spline actually runs --
// before ever reaching the bottom corner, so the nameplate visually landed
// on top of a track spline despite technically not occupying a "blocked"
// slot. The bottom vertex is just as legitimate a corner as any other and,
// per the user's own explicit suggestion, a much safer fallback than an
// edge slot for a hex whose track fans out in every other direction.
//
// Design note #105: REORDERED again, per direct request -- CENTER (slot 0)
// now tried FIRST, then the TOP vertex (slot 7), then the BOTTOM vertex
// (slot 10), with the remaining slots following in the same relative order
// #74 left them in. Center is blocked on the overwhelming majority of
// named hexes (any hex with live track through it, or a SingleCity/
// SingleTown archetype's own station/dit circle -- see `hexBlockedSlots`),
// so in practice this is a no-op fallthrough to the top vertex for nearly
// every hex; it only actually WINS on a genuinely blank, trackless named
// hex, where `hexSlotDirection(0)` resolves to `{x:0,y:0}` and
// `singleNodeNameplateAnchor` (below) renders dead-center, same as this
// system's DoubleCity/DoubleTown nameplates already always do.
const NAMEPLATE_SLOT_PREFERENCE: readonly number[] = [0, 7, 10, 12, 8, 11, 9, 6, 1, 5, 2, 4, 3];

function singleNodeNameplateAnchor(
  center: { x: number; y: number },
  size: number,
  mapGrid: MapGridResponse,
  q: number,
  r: number,
  // Design note #74: shared cross-pass claiming ledger (see `claimHexSlot`'s
  // own doc comment) -- nameplates previously called `pickHexSlot` directly,
  // completely unaware of what the restriction-badge/revenue-badge passes
  // on the SAME hex had already claimed (or would later claim), which let a
  // nameplate and a restriction badge land on the EXACT same slot (reported:
  // Baltimore/I15's nameplate and its "B" restriction badge both
  // independently resolving to the same upper-left corner once Baltimore's
  // real edge-0/edge-4 track blocks every other corner). Now the FIRST of
  // the slot-picking passes to run each render (nameplate, then restriction,
  // then terrain-cost, then revenue badge), so it gets first pick, exactly
  // as before for the common case, while every later pass now sees its own
  // claim and avoids it.
  claimedHexSlots: Map<string, Set<number>>,
): { x: number; y: number } {
  const blocked = hexBlockedSlots(mapGrid, q, r);
  const dead = slotsBlockedByEdges(deadEdgesAt(q, r), false);
  const nameplateForce = HEX_SLOT_FORCE[`${q},${r}`]?.nameplate;
  const nameplateOverride = resolveSlotOverride(q, r, "nameplate");
  const nameplatePreference = withSlotReserve(q, r, "nameplate", NAMEPLATE_SLOT_PREFERENCE);
  const slot =
    nameplateForce !== undefined
      ? claimHexSlotForced(claimedHexSlots, q, r, nameplateForce)
      : claimHexSlotPreferring(claimedHexSlots, q, r, nameplateOverride, nameplatePreference, blocked, dead);
  if (slot === 12) {
    // Design note #55's own exact literal formula, preserved byte-for-byte
    // for the default (and overwhelmingly common) case.
    return { x: center.x - size * 0.25, y: center.y - size * 0.35 };
  }
  const magnitude = Math.hypot(0.25, 0.35) * size;
  const direction = hexSlotDirection(slot);
  return { x: center.x + direction.x * magnitude, y: center.y + direction.y * magnitude };
}

/** Frontend mirror of the Rust backend's `hexmap::describe_hex` -- given an
 *  axial `(q, r)`, returns the same style of human-readable label a player
 *  would expect: the board's own printed coordinate (preferring a
 *  landmark's city name when the hex is a landmark, or an off-board zone's
 *  name when it's a red off-board hex), or an explicit off-board fallback
 *  string when the hex isn't part of the real 93-hex board at all. Used by
 *  the click interceptor (design note #7) to label its popup/loading states
 *  without a round-trip query just to learn a hex's name. */
function describeHex(q: number, r: number): string {
  const landmark = LANDMARK_HEXES.find((entry) => entry.q === q && entry.r === r);
  if (landmark) return `${landmark.name} (${landmark.label})`;

  const boardHex = STATIC_BOARD_HEXES.find((entry) => entry.q === q && entry.r === r);
  if (boardHex) {
    const offboardName = OFFBOARD_LABELS[boardHex.label];
    if (offboardName) return `${offboardName} (${boardHex.label})`;
    // Dynamic City Nameplate Suppression (design note #47): this function
    // previously fell straight through to the bare coordinate label
    // (`"J14"`) for every `NAMED_HEX_LABELS` city -- Washington, Toledo,
    // Providence, Albany, Cleveland, Altoona, and the rest never had their
    // real name in the tooltip at all, landmark/off-board names aside. That
    // was a real, previously-uncaught gap in its own right, and now a load-
    // bearing one: once a laid tile suppresses a city's ON-CANVAS nameplate
    // (see the drawing passes below), the hover tooltip becomes the ONLY
    // remaining place that name is shown at all -- so it must actually
    // carry it. Checked here rather than in the caller so every one of
    // `describeHex`'s existing call sites (tile-selection console.log
    // included) picks up the fix at once.
    const namedLabel = NAMED_HEX_LABELS[boardHex.label];
    return namedLabel ? `${namedLabel} (${boardHex.label})` : boardHex.label;
  }

  return `(${q}, ${r}) [off the authentic 1830 board]`;
}

/** Debug-only descriptor of hex `(q, r)`'s PRE-PRINTED terrain/designation
 *  -- independent of whatever tile a player may have actually laid there --
 *  built for the tile-selection click console.log below (Tile Selection
 *  Catalog verification pass, item 1). Mirrors the exact same lookup
 *  priority `describeHex`/`hexRouteValue` already use: `LANDMARK_HEXES`
 *  first, then a `GRAY_HEXES` real-track marker, then `YELLOW_OO_HEXES`,
 *  then `townDesignation`/`cityDesignation`, falling back to an ordinary
 *  ungated hex or off-board.
 *
 *  NOTE on the `YELLOW_OO_HEXES` branch's `designation` string: item 1's
 *  investigation (immediate click-time log, this function) originally found
 *  that `TILE_CATALOG` had no distinct double-city tile type at all --
 *  every `CITY_DESIGNATED_HEXES` entry, OO hexes included, required plain
 *  `MajorCityHub`. That gap is what item 2 of this same pass fixed: a new
 *  `TerrainType.DoubleCityHub` (tile 15, real 1830 tile 59), a new
 *  `OO_DESIGNATED_HEXES` list split out of `CITY_DESIGNATED_HEXES`, and an
 *  updated City Reservation gate in `hexmap.rs` (module doc comment #18).
 *  This branch now correctly reports "DoubleCityHub" rather than
 *  "MajorCityHub" for an OO hex. */
function describeHexDesignationForLog(
  q: number,
  r: number,
): { hexLabel: string; terrainType: TerrainType | "None"; designation: string } {
  const landmark = LANDMARK_HEXES.find((entry) => entry.q === q && entry.r === r);
  if (landmark) {
    return {
      hexLabel: landmark.label,
      terrainType: "MajorCityHub",
      designation: `Landmark: ${landmark.name} (LANDMARK_HEXES)`,
    };
  }

  const boardHex = STATIC_BOARD_HEXES.find((entry) => entry.q === q && entry.r === r);
  if (boardHex) {
    const grayTrack = GRAY_HEXES[boardHex.label];
    if (grayTrack && grayTrack.marker !== "none") {
      return {
        hexLabel: boardHex.label,
        terrainType: grayTrack.marker === "city" ? "MajorCityHub" : "SmallTown",
        designation: `Preprinted GRAY ${grayTrack.marker} (CITY_DESIGNATED_HEXES/TOWN_DESIGNATED_HEXES)`,
      };
    }
    if (YELLOW_OO_HEXES.has(boardHex.label)) {
      return {
        hexLabel: boardHex.label,
        terrainType: "DoubleCityHub",
        designation:
          "Preprinted YELLOW OO double-city (OO_DESIGNATED_HEXES) -- Tile Selection Catalog verification pass: now strictly requires DoubleCityHub artwork (tile 15, the real 1830 tile 59), rejecting an ordinary MajorCityHub tile here",
      };
    }
    if (boardHex.townDesignation) {
      return {
        hexLabel: boardHex.label,
        terrainType: boardHex.townDesignation === "double" ? "DoubleTown" : "SmallTown",
        designation: "Blank Town-designated, no printed track yet (TOWN_DESIGNATED_HEXES)",
      };
    }
    if (boardHex.cityDesignation) {
      return {
        hexLabel: boardHex.label,
        terrainType: "MajorCityHub",
        designation: "Blank City-designated, no printed track yet (CITY_DESIGNATED_HEXES)",
      };
    }
    return { hexLabel: boardHex.label, terrainType: "None", designation: boardHex.type };
  }

  return { hexLabel: `(${q}, ${r})`, terrainType: "None", designation: "off the authentic 1830 board" };
}

/** Frontend mirror of `hexmap::terrain_base_value` -- the SAME flat,
 *  terrain-only $ value the backend computes for `RunManualRoute`'s payout
 *  math (see `src/hexmap.rs`). Deliberately flat/terrain-based, NOT
 *  phase/color-tier-dependent -- see design note #26/item 5 for why that
 *  matters: the two example numbers a later request gave ($10 towns / $20
 *  base cities) DO match this table, but the "based on the current game
 *  phase tier" framing that request used does not match how this contract
 *  actually prices a route, since a hex's value never changes as the game
 *  advances through color tiers. */
function terrainBaseValue(terrain: TerrainType): number {
  switch (terrain) {
    case "Plain":
    case "MountainRugged":
      return 0;
    case "SmallTown":
      return 10;
    case "DoubleTown": // flat $10, mirrors hexmap::terrain_base_value (backend module doc comment #21) -- NOT $20 (two $10 stops summed): a route can only ever reach ONE of the hex's two town stops in a single continuous visit, the same single-visit reasoning DoubleCityHub's own $80->$40 correction already established, just never backported to DoubleTown until that pass
      return 10;
    case "MajorCityHub":
      return 20;
    case "DoubleCityHub": // real 1830 tile 59's per-station $40, NOT both stations at once -- mirrors hexmap::terrain_base_value, reverted from an earlier pass's $80 overcorrection (backend module doc comment #20 follow-up): tile 59's two stations are real disconnected one-edge stubs with no path between them, so a single continuous transit can only ever reach one station per visit
      return 40;
    case "BostonHub": // design note #49, mirrors hexmap::terrain_base_value's BostonHub => 20 (module doc comment #26/#27) -- same flat single-city bucket as MajorCityHub
      return 20;
    case "NewYorkHub": // design note #49, mirrors hexmap::terrain_base_value's NewYorkHub => 40 -- same flat per-station bucket as DoubleCityHub
      return 40;
  }
}

/** Resolves the $ route value to show for hex `(q, r)` in the enriched
 *  hover tooltip (design note #26/item 2) and the on-board value badges
 *  (design note #26/item 5). Mirrors the SAME priority order `draw()`
 *  itself already uses to decide what's rendered on a hex: a laid tile's
 *  own terrain (from `TILE_CATALOG`) wins first, then the three fixed
 *  landmark cities (always `MajorCityHub`), then a pre-printed gray hex's
 *  own city/town/none marker, then a yellow "OO" hex (always
 *  `MajorCityHub` -- two $20 stations, see `YELLOW_OO_HEXES`), then a
 *  plain unlaid hex's flat $0. Off-board red revenue zones are deliberately
 *  excluded (returns `null`) -- those already have their own, genuinely
 *  era-tiered `OFFBOARD_REVENUE` value (design note #22), a DIFFERENT
 *  value system from this terrain-based one, and callers fall back to that
 *  instead. */
function hexRouteValue(q: number, r: number, mapGrid: MapGridResponse): number | null {
  const laidTile = mapGrid.tiles.find((t) => t.q === q && t.r === r);
  if (laidTile) {
    const catalogEntry = TILE_CATALOG_BY_ID.get(laidTile.tile_id);
    if (catalogEntry) return terrainBaseValue(catalogEntry.terrain);
  }

  const landmark = LANDMARK_HEXES.find((l) => l.q === q && l.r === r);
  const boardHex = STATIC_BOARD_HEXES.find((h) => h.q === q && h.r === r);
  // Design note #35/items 2-3: a per-hex real-value override, checked
  // BEFORE the flat-by-terrain fallback below -- see
  // `HEX_START_VALUE_OVERRIDE`'s own doc comment for the sourced $ figures
  // and the two factual corrections (F6 is Cleveland, not "Chicago"; F24 is
  // a Town hex, not one of the city hubs this override table covers) this
  // uncovered. Any hex not listed there (e.g. Lansing/Altoona/Rochester/
  // Richmond, or any `townDesignation` hex) falls straight through to the
  // untouched flat logic beneath, unaffected.
  const overrideLabel = landmark?.label ?? boardHex?.label;
  if (overrideLabel !== undefined && overrideLabel in HEX_START_VALUE_OVERRIDE) {
    return HEX_START_VALUE_OVERRIDE[overrideLabel];
  }

  if (landmark) {
    return terrainBaseValue("MajorCityHub");
  }

  if (boardHex) {
    if (OFFBOARD_LABELS[boardHex.label]) return null;
    const grayTrack = GRAY_HEXES[boardHex.label];
    if (grayTrack) {
      if (grayTrack.marker === "city") return terrainBaseValue("MajorCityHub");
      if (grayTrack.marker === "town") return terrainBaseValue("SmallTown");
      return terrainBaseValue("Plain");
    }
    if (YELLOW_OO_HEXES.has(boardHex.label)) return terrainBaseValue("MajorCityHub");
    // Design note #37 (corrects the previous pass's `return null` here --
    // reported: a blank `townDesignation` hex showed NO value suffix at
    // all in the tooltip, inconsistent with every blank `cityDesignation`
    // hex just below, which shows an explicit "(Value: $0)" via
    // `HEX_START_VALUE_OVERRIDE`'s real sourced $0 entries. A blank
    // `townDesignation` hex -- unlike `GRAY_HEXES`'s three real-track towns
    // (Kingston/Atlantic City/Fall River, handled by the `grayTrack` branch
    // above) -- has no printed track at all, so its real printed value IS
    // $0, the same fact that already justifies `cityDesignation`'s $0
    // figure below -- there's no principled reason for one blank-hex
    // category to hide its value while the other shows "$0" explicitly.
    // Flat `0`, not a per-hex `HEX_START_VALUE_OVERRIDE` entry, since
    // there's no individually-sourced figure to look up here -- both
    // single- and double-town blank hexes get the same $0 (the ON-BOARD
    // badge for these hexes stays suppressed regardless, per the separate,
    // still-correct "Only Real-Track Towns Show Revenue" fix in `draw()`
    // below -- that fix was about the visible badge plate, not this
    // tooltip text).
    if (boardHex.townDesignation) return 0;
    // Design note #34/item 2: `cityDesignation` hexes get the same flat
    // `MajorCityHub` $20 value `townDesignation` hexes already get above --
    // both are ordinary blank hexes with no real printed track. SUPERSEDED
    // for all eight of these specific hexes by `HEX_START_VALUE_OVERRIDE`'s
    // real $0 above (design note #35/item 3); this fallback branch is now
    // only reachable if a NEW `cityDesignation` hex is ever added without
    // also adding a matching override entry.
    if (boardHex.cityDesignation) return terrainBaseValue("MajorCityHub");
    return terrainBaseValue("Plain");
  }

  return null;
}

/** Builds the enriched "{label}: {name} (Value: $X) (Terrain Cost: $Y)"
 *  hover tooltip string (design note #26/item 2) -- `describeHex`'s own
 *  coordinate/name text plus, where applicable, a
 *  `hexRouteValue`/`offboardValueForEra` value suffix and a terrain-cost
 *  suffix. Off-board red zones use their own era-tiered value (design note
 *  #22) instead of the flat terrain table, since that's the value that's
 *  actually relevant there; a hex with no applicable value (off the real
 *  board entirely) prints no value suffix at all.
 *
 *  Design note #103: two follow-up fixes, per direct request. (a) The
 *  `(Value: $X)` suffix is now suppressed when `X` is `0` -- design note
 *  #35/#37 had deliberately kept a literal "(Value: $0)" for hexes whose
 *  on-canvas badge is itself hidden at $0, reasoning the tooltip was the
 *  only place that fact was visible; per this direct request, that's
 *  reversed -- the suffix now only appears for an ACTUAL (nonzero) value,
 *  same standard applied to both the flat `hexRouteValue` path and the
 *  off-board `offboardValueForEra` path (though real off-board revenue is
 *  never $0 in practice). `hexRouteValue`'s own return value is untouched
 *  -- still literally `0` for those hexes -- only this tooltip-string
 *  formatting layer changed. (b) A new `(Terrain Cost: $Y)` suffix is
 *  appended for any Mountain/River hex, reusing
 *  `TERRAIN_BUILD_COST_LABEL` (the same source the on-canvas red cost
 *  badge draws from, #68/#87) -- note that constant's own values are bare
 *  digits since #94 dropped their `$` prefix for the badge, so a `$` is
 *  re-added here for this text-sentence context.
 *
 *  Design note #117: a new `(Stations: N)` suffix, per direct request
 *  ("when a tile has stations on it") -- SUPERSEDED by design note #118
 *  below. `N` was a CAPACITY count derived from `archetypeForHex` (how many
 *  station tokens could ever occupy this hex), not which companies actually
 *  have one placed there.
 *
 *  Design note #118: corrected per direct follow-up -- the request was
 *  never a count, it was "what stations are there": which corporation(s)
 *  actually have a station token ON this hex right now, printed by
 *  `ticker` (e.g. `"PRR"`), not a bare number. Reworked to cross-reference
 *  `publicCompanies` (this component's own `StationTokenCompany[]` prop,
 *  design note #36) against `(q, r)`: any company whose
 *  `station_token_hexes` array contains this exact pair has a token here.
 *  Tickers are collected in `publicCompanies`' own array order (that
 *  array's order is itself stable across a poll -- `App.tsx` passes
 *  `state.public_companies` straight through, sourced from the backend's
 *  own fixed `PUBLIC_COMPANIES` ordering), joined with `", "`. Singular
 *  `(Station: X)` for exactly one company, plural `(Stations: X, Y)` for
 *  two or more -- matching the exact two example strings from the
 *  request -- and the suffix is omitted ENTIRELY (not printed as
 *  `(Stations: )` or `(Stations: 0)`) when no company has a token on this
 *  hex, same "only appears when true" standard design note #103 applied to
 *  the Value suffix. Appended last, after the value/terrain-cost suffixes
 *  above, matching this function's own established left-to-right ordering
 *  (name, then value, then cost, then stations). */
function describeHexWithValue(
  q: number,
  r: number,
  mapGrid: MapGridResponse,
  currentEra: TileColorTier,
  publicCompanies: readonly StationTokenCompany[],
): string {
  const base = describeHex(q, r);
  const boardHex = STATIC_BOARD_HEXES.find((h) => h.q === q && h.r === r);

  let result = base;

  const offboardName = boardHex ? OFFBOARD_LABELS[boardHex.label] : undefined;
  if (offboardName) {
    const tiers = OFFBOARD_REVENUE[offboardName];
    if (tiers) {
      const offboardValue = offboardValueForEra(tiers, currentEra);
      if (offboardValue !== 0) result = `${result} (Value: $${offboardValue})`;
    }
  } else {
    const value = hexRouteValue(q, r, mapGrid);
    if (value !== null && value !== 0) result = `${result} (Value: $${value})`;
  }

  if (boardHex) {
    // Design note #136 (F-2): resolved by COORDINATE through the mirror of
    // `hexmap::terrain_build_fee`, not by looking the hex's display type up
    // in a label table.
    const terrainFee = terrainBuildFeeAt(q, r);
    if (terrainFee > 0) result = `${result} (Terrain Cost: $${terrainFee})`;
  }

  // Design note #118: real placed station tokens, by ticker -- not a
  // capacity count.
  const tickersHere = publicCompanies
    .filter((company) => company.station_token_hexes.some(([hexQ, hexR]) => hexQ === q && hexR === r))
    .map((company) => company.ticker);
  if (tickersHere.length === 1) {
    result = `${result} (Station: ${tickersHere[0]})`;
  } else if (tickersHere.length > 1) {
    result = `${result} (Stations: ${tickersHere.join(", ")})`;
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* Component                                                          */
/* ------------------------------------------------------------------ */

/** One train's traced route, for the map overlay -- design note #137 (F-1). */
export interface RouteOverlay {
  /** Short label for the train running this route, e.g. `"3-Train"`. Drawn
   *  nowhere by this component today; carried so a future legend, tooltip or
   *  hover-highlight has it without a second plumbing pass. */
  trainLabel: string;
  /** CSS colour for this route's stroke. One distinct colour per train, so
   *  overlapping routes stay tellable apart -- which is the entire point of
   *  drawing more than one. */
  color: string;
  /** The hexes this route runs through, IN ORDER. Consecutive entries must be
   *  adjacent; a non-adjacent pair is skipped rather than drawn as a straight
   *  line across the board (see `drawRouteOverlays`). */
  hexes: Array<[number, number]>;
}

const EMPTY_ROUTE_OVERLAYS: readonly RouteOverlay[] = [];

export interface HexGridRendererProps {
  /** `QueryMsg::GetMapGrid`'s response, verbatim. */
  mapGrid: MapGridResponse;
  /** Pixel radius (center to corner) of one hex. Default 42. */
  hexSize?: number;
  /** Explicit pixel size override. Omit both (the default, and the expected
   *  usage per design note #19/Request F item 3, refined by design note
   *  #27/item 1) to let this component measure its own wrapping `<div>`'s
   *  available WIDTH via `ResizeObserver` and flex-fill that; `height` in
   *  that case is no longer independently measured -- it's DERIVED from the
   *  real board's own aspect ratio at that width, so the canvas always
   *  renders at its true full proportional size instead of being cropped to
   *  fit a bounded ancestor pane. Provide both explicitly to keep the old
   *  fixed-pixel, independently-set-dimensions behavior. */
  width?: number;
  height?: number;
  className?: string;
  /** Enables the click interceptor (design note #7): when all four of
   *  `queryClient`/`contractAddress`/`gameId`/`protocolId` are provided, a
   *  genuine click on a hex (as opposed to a pan drag -- see
   *  `handlePointerUp`) converts the pixel to `(q, r)` and fires
   *  `GetLegalTilePlacements` against `queryClient`. Omit any of them to
   *  keep this component's original pan/zoom-only, query-free behavior. */
  queryClient?: QueryCapableClient;
  contractAddress?: string;
  gameId?: number;
  protocolId?: number;
  /** Traced train routes to draw over the rail map -- design note #137
   *  (F-1). One entry per train; omit or pass `[]` for no overlay.
   *
   *  This is the layer the board previously had NO equivalent of: track was
   *  drawn, but which track a train actually RAN was never shown, so a player
   *  building a manual route had no visual confirmation of the path they were
   *  assembling. */
  routeOverlays?: readonly RouteOverlay[];
  /** Fired synchronously on every genuine hex click, before the
   *  `GetLegalTilePlacements` query (if enabled) resolves -- lets the host
   *  app position a popup immediately instead of waiting on the network. */
  onHexClick?: (info: {
    q: number;
    r: number;
    hexLabel: string;
    clientX: number;
    clientY: number;
  }) => void;
  /** Reports the click-triggered `GetLegalTilePlacements` query's
   *  lifecycle -- see `HexClickQueryState`. */
  onHexClickQuery?: (state: HexClickQueryState) => void;
  /** When set, draws a translucent dashed-outline "ghost" preview of
   *  `tileId` at `orientation` on hex `(q, r)` -- the live map preview (see
   *  design note #7 / item 3 of the popup feature). */
  previewTile?: { q: number; r: number; tileId: number; orientation: number } | null;
  /** The room's live `GameStateResponse.current_global_era` -- see design
   *  note #15/item 4. Drives which single off-board revenue tier renders
   *  inside each red off-board hex. Defaults to `"Yellow"` (every new
   *  game's real starting era) so this component still renders sensibly
   *  when the host app hasn't wired a live `GetGameState` query yet. */
  currentEra?: TileColorTier;
  /** The room's live `GameStateResponse.public_companies`, verbatim (or a
   *  `StationTokenCompany[]` subset of it) -- see design note #36. Drives
   *  the Station Token marker rendering pass: a muted preprinted marker at
   *  each `STATION_HOME_HEXES` entry for any company not yet `is_floated`,
   *  and a real ticker-labeled marker at every one of a floated company's
   *  own `station_token_hexes`. Defaults to an empty array, so this
   *  component still renders its existing city circles sensibly (just with
   *  no Station Token overlay at all) when the host app hasn't wired a
   *  live `GetGameState` query yet -- the same fallback pattern `currentEra`
   *  above already establishes. */
  publicCompanies?: StationTokenCompany[];
}

interface ViewTransform {
  panX: number;
  panY: number;
  zoom: number;
}

const DEFAULT_HEX_SIZE = 42;
const DEFAULT_WIDTH = 900;
const DEFAULT_HEIGHT = 640;
/** Design note #36/item 1: was a flat `MAX_ZOOM = 3` ABSOLUTE cap, applied
 *  not just to the interactive zoom-in handlers below but to `minZoom`
 *  itself (the baseline board-fit zoom) -- on a wide-enough viewport,
 *  `fitZoom = width / boundsWidth` legitimately exceeds `3`, and that old
 *  absolute cap would silently clamp the baseline fit back DOWN to `3`,
 *  leaving real unused width on a widescreen pane instead of letting the
 *  board's true full-width scale (this item's "static max/min scale
 *  fraction override" that "compresses our map"). Redefined as a
 *  MULTIPLIER on `minZoom` instead of an absolute pixel-density constant --
 *  every use site below now computes `minZoom * MAX_ZOOM_MULTIPLIER`
 *  fresh, so the interactive "zoom in past the fit baseline" ceiling always
 *  scales WITH the baseline instead of ever being able to sit below it
 *  (the old absolute constant could invert -- a `minZoom` of `4` on a very
 *  wide viewport with the old `MAX_ZOOM = 3` would have made the
 *  "detail zoom" ceiling literally SMALLER than the baseline fit, an
 *  impossible zoomed-OUT "zoom in" button). `3` is kept as the multiplier's
 *  own value -- unrelated to the old absolute-pixel-density meaning, it
 *  just happens to be a reasonable "3x closer than the full-board fit"
 *  interactive zoom-in ceiling either way. */
const MAX_ZOOM_MULTIPLIER = 3;
/** Absolute safety floor under the dynamically-computed board-fit minimum
 *  zoom (design note #8) -- guards only against a degenerate near-zero
 *  viewport/`hexSize` combination; in normal use the computed `minZoom`
 *  below is always well above this. */
const ABSOLUTE_MIN_ZOOM_FLOOR = 0.1;

/** Rail Map Overhaul (design note #42): "Clean Up Control Overlay Overlaps."
 *  The old separate "Toggle Detailed View" button (design note #13) is
 *  removed outright per that item's explicit instruction -- `detailedView`
 *  itself is UNCHANGED (still gates pan/zoom, design note #13), it's just no
 *  longer toggled by its own dedicated button; `handleZoomStep` (design note
 *  #17) already flips it on by itself the moment "+"/"-" is pressed, and
 *  "Fit to Screen" already re-locks it back off, so removing this one
 *  redundant control loses no capability. The former "+"/"-"/"Fit to
 *  Screen" stack is consolidated into ONE floating "clean container" (this
 *  panel) -- a single bordered/backed card holding City Names/"-"/"+"/"Fit
 *  to Screen" as a horizontal row -- instead of two separate overlay
 *  clusters. Positioned top-right (the corner the old toggle button used to
 *  occupy) with a generous `20px` margin inset -- larger than the old
 *  16px -- specifically so this single compact row sits further inside the
 *  canvas, away from `drawBoardMarginLabels`' own row-letter/column-number
 *  text, which (design note #28) is drawn deliberately close to the true
 *  board edge. */
const MAP_CONTROLS_PANEL_STYLE: React.CSSProperties = {
  position: "absolute",
  top: "20px",
  right: "20px",
  zIndex: 5,
  display: "flex",
  flexDirection: "row",
  alignItems: "stretch",
  gap: "6px",
  padding: "8px",
  borderRadius: "10px",
  border: "1.5px solid #5c6a52",
  backgroundColor: "rgba(20, 20, 20, 0.85)",
  boxShadow: "0 2px 8px rgba(0, 0, 0, 0.5)",
};

/** Base style shared by every button inside `MAP_CONTROLS_PANEL_STYLE` --
 *  see design note #42. `minWidth`/`textAlign` keep the single-character
 *  "+"/"-" buttons the same width as their wordier siblings in the same
 *  row. */
const CAMERA_CONTROL_BUTTON_STYLE: React.CSSProperties = {
  padding: "10px 14px",
  borderRadius: "6px",
  border: "2px solid #5c6a52",
  backgroundColor: "rgba(255, 255, 255, 0.06)",
  color: "#f4ecd8",
  fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
  fontSize: "18px",
  fontWeight: 700,
  lineHeight: 1,
  cursor: "pointer",
  minWidth: "44px",
  textAlign: "center",
};

/** The floating "G19: New York (Value: $20)"-style coordinate+value
 *  tooltip -- see design note #21, scaled up and value-enriched by design
 *  note #26/item 2. `position: fixed` since it tracks the raw viewport
 *  pointer position (`clientX`/`clientY`), not anything relative to the
 *  wrapping panel. `pointerEvents: "none"` so it can never itself intercept
 *  the pointer events it's reporting on. Padding/font size roughly doubled
 *  from the original coordinate-only tooltip (design note #21) so the now-
 *  longer "{label}: {name} (Value: $X)" string stays fully legible instead
 *  of reading as a cramped afterthought. */
const HOVER_TOOLTIP_STYLE: React.CSSProperties = {
  position: "fixed",
  zIndex: 20,
  pointerEvents: "none",
  padding: "9px 16px",
  borderRadius: "10px",
  backgroundColor: "rgba(18, 20, 26, 0.94)",
  border: "2px solid #6a7285",
  color: "#f4ecd8",
  fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
  fontSize: "20px",
  fontWeight: 700,
  whiteSpace: "nowrap",
  boxShadow: "0 4px 14px rgba(0, 0, 0, 0.55)",
};

interface BoardContentBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** The `[lo, hi]` pan range, along one axis, that keeps the board's own
 *  footprint from ever being fully dragged out of the canvas viewport at a
 *  given zoom level -- see design note #8. A single formula handles both
 *  the "board bigger than the viewport" case (keep the viewport inside the
 *  board) and the "board smaller than the viewport" case (keep the board
 *  inside the viewport): the two raw candidate bounds swap their min/max
 *  ordering exactly at the point where the board's scaled size crosses the
 *  viewport size, so sorting them always produces the correct pair either
 *  way, with no branching needed. */
function panClampRange(
  boundMin: number,
  boundMax: number,
  zoom: number,
  viewportSize: number,
): { lo: number; hi: number } {
  const a = viewportSize - boundMax * zoom;
  const b = -boundMin * zoom;
  return { lo: Math.min(a, b), hi: Math.max(a, b) };
}

/** Clamps a candidate `(panX, panY)` into the range `panClampRange`
 *  computes for each axis -- see design note #8. */
function clampPanToBoard(
  panX: number,
  panY: number,
  zoom: number,
  bounds: BoardContentBounds,
  viewportWidth: number,
  viewportHeight: number,
): { panX: number; panY: number } {
  const xRange = panClampRange(bounds.minX, bounds.maxX, zoom, viewportWidth);
  const yRange = panClampRange(bounds.minY, bounds.maxY, zoom, viewportHeight);
  return {
    panX: Math.min(xRange.hi, Math.max(xRange.lo, panX)),
    panY: Math.min(yRange.hi, Math.max(yRange.lo, panY)),
  };
}

/** Stable empty-array default for the `publicCompanies` prop (design note
 *  #36) -- a fresh `[]` literal in the destructuring default below would
 *  be a NEW array reference on every render, which would in turn make
 *  `draw`'s own `useCallback` dependency array (which includes
 *  `publicCompanies`) see a "changed" dependency every render and rebuild
 *  the callback needlessly. One shared module-level reference avoids that.
 *  Typed as plain (non-`readonly`) `StationTokenCompany[]`, matching the
 *  prop's own declared type exactly -- never actually mutated, but a
 *  `readonly` array literal here would not be assignable to that
 *  destructuring default. */
const EMPTY_PUBLIC_COMPANIES: StationTokenCompany[] = [];

export function HexGridRenderer({
  mapGrid,
  hexSize = DEFAULT_HEX_SIZE,
  width: widthProp,
  height: heightProp,
  className,
  queryClient,
  contractAddress,
  gameId,
  protocolId,
  onHexClick,
  onHexClickQuery,
  previewTile,
  currentEra = "Yellow",
  publicCompanies = EMPTY_PUBLIC_COMPANIES,
  routeOverlays = EMPTY_ROUTE_OVERLAYS,
}: HexGridRendererProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rafHandleRef = useRef<number | null>(null);
  /** Live-measured size of the wrapping `<div>` -- see design note #19.
   *  Only consulted when `widthProp`/`heightProp` are omitted; seeded with
   *  the old fixed defaults purely as a sane first-paint fallback before
   *  the `ResizeObserver` below reports its first real measurement. */
  const [measuredSize, setMeasuredSize] = useState<{ width: number; height: number }>({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
  });

  useEffect(() => {
    if (widthProp !== undefined && heightProp !== undefined) return;
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width: observedWidth, height: observedHeight } = entry.contentRect;
      // Guard against a transient near-zero-size measurement clobbering the
      // last known-good `measuredSize` (design note #34/item 1). Originally
      // just `< 1`, which only caught a literal zero -- too narrow to catch
      // the actual reported bug: switching away from this component's tab
      // and back (a React re-render that toggles the host pane's display,
      // not an unmount) can report a transient SINGLE-DIGIT pixel size for
      // one observation (e.g. a hidden pane briefly reporting `contentRect`
      // as `{width: 4, height: 2}` mid-swap, before layout settles back to
      // its real size) -- comfortably past the old `< 1` gate, so it used to
      // sail through and collapse `measuredSize` (and therefore `hexSize`/
      // `minZoom`/the whole camera fit) down to that near-zero size, which
      // is the "crashing the layout down to zero" this item reports.
      // Widened to `<= 10`: still small enough that no real, usable board
      // pane will ever legitimately measure at or under it, but comfortably
      // covers the transient tab-swap readings actually seen. Simply
      // `return`ing here (skipping `setMeasuredSize` entirely) is already
      // exactly the "preserve last known valid ... settings" behavior this
      // item asks for -- React state isn't touched, so `measuredSize` stays
      // at whatever it was before this bad reading, with zero extra state
      // needed to "remember" it separately.
      if (observedWidth <= 10 || observedHeight <= 10) return;
      setMeasuredSize((prev) => {
        if (prev.width === observedWidth && prev.height === observedHeight) return prev;
        return { width: observedWidth, height: observedHeight };
      });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [widthProp, heightProp]);

  // The board's own fixed, unscaled footprint -- deliberately memoized on
  // `hexSize` alone, NOT on `mapGrid.tiles` (design note #8): the
  // clampable/fittable area is the physical board, not whatever happens to
  // be laid on it yet. MOVED above the `width`/`height` derivation below
  // (design note #27/item 1) -- `height` is now DERIVED from this board's
  // own aspect ratio, so it has to exist first.
  const boardContentBounds = useMemo<BoardContentBounds>(() => {
    const points = [
      ...STATIC_BOARD_HEXES.map((h) => axialToPixel(h.q, h.r, hexSize)),
      ...LANDMARK_HEXES.map((l) => axialToPixel(l.q, l.r, hexSize)),
    ];
    // Design note #26: tightened to the hexes' own true outermost
    // coordinate edges -- `hexSize` is the exact center-to-corner radius
    // (see `pointOnCircle(center, size, cornerAngleRad(i))` in
    // `drawHexPath`), so padding by exactly `hexSize` is the tight,
    // mathematically-derived bound against each edge hex's real corner,
    // not an arbitrary buffer. The previous `hexSize * 2.5` term (extra
    // clearance reserved for the margin labels drawn outside the board)
    // has been removed outright per that item's explicit "completely
    // remove any large hardcoded pixel padding" instruction -- see design
    // note #26 for the accepted margin-label tradeoff this creates.
    //
    // FOLLOW-UP ("Camera Padding Must Reserve Room For Margin Labels"):
    // design note #26's tight `hexSize`-only padding left literally ZERO
    // slack beyond each edge hex's own corner point -- fine for the board
    // itself, but it meant there was no room at all left over for the
    // margin labels drawn just outside that corner, which is the deeper
    // reason column-number labels kept overlapping the top/bottom hexes
    // even after `computeBoardMarginLabels`'s own width-vs-height
    // measurement bug was fixed (that fix corrected WHICH dimension the
    // label's clearance came from, but there was no budget left in that
    // dimension to spend). `marginLabelReserve` adds back a small,
    // proportional reservation -- NOT the old flat `hexSize * 2.5` -- sized
    // off `hexSize`/font size alone so it stays a minimal, formula-derived
    // top-up rather than the "large hardcoded pixel padding" that note #26
    // was written to remove. `computeBoardMarginLabels` MUST keep deriving
    // its own `hexEdgePadding` from this exact same total (see its own
    // comment) or the two fall back out of sync.
    const hexEdgePadding = hexSize + marginLabelReserve(hexSize);
    return {
      minX: Math.min(...points.map((p) => p.x)) - hexEdgePadding,
      maxX: Math.max(...points.map((p) => p.x)) + hexEdgePadding,
      minY: Math.min(...points.map((p) => p.y)) - hexEdgePadding,
      maxY: Math.max(...points.map((p) => p.y)) + hexEdgePadding,
    };
  }, [hexSize]);

  const width = widthProp ?? measuredSize.width;
  /** ITEM 1 FIX (design note #27): `height` used to come straight from the
   *  `ResizeObserver`'s own measured container height -- which only ever
   *  reflected whatever fixed/clamped height an ancestor pane imposed (see
   *  `App.tsx` design note #13), i.e. exactly the "tiny panel box" this item
   *  reports. Now that no ancestor imposes one, that measurement would be
   *  meaningless (a `height: auto` box just mirrors back whatever this
   *  component itself renders -- circular). `height` is now DERIVED from
   *  the board's own true aspect ratio (`boardContentBounds`) at the
   *  available `width`, so the canvas always renders at its full natural
   *  proportional height for that width -- "true maximum proportional scale
   *  bounds," not vertically cropped/shrunk to fit whatever bounded
   *  viewport happened to be available. Ancestors are now free to just grow
   *  to match (`App.tsx` design note #13), letting the BROWSER's own page
   *  scrollbar carry the rest. */
  const height = useMemo(() => {
    if (heightProp !== undefined) return heightProp;
    const boundsWidth = Math.max(boardContentBounds.maxX - boardContentBounds.minX, 1);
    const boundsHeight = Math.max(boardContentBounds.maxY - boardContentBounds.minY, 1);
    return Math.round(width * (boundsHeight / boundsWidth));
  }, [heightProp, boardContentBounds, width]);
  /** Monotonic counter guarding against a stale `GetLegalTilePlacements`
   *  response (from an earlier click) resolving after a newer click's
   *  request has already superseded it -- only the most recent request's
   *  result is ever reported to `onHexClickQuery`. */
  const clickQuerySeqRef = useRef(0);

  const [view, setView] = useState<ViewTransform>({
    panX: width / 2,
    panY: height / 2,
    zoom: 1,
  });
  const dragStateRef = useRef<{
    startX: number;
    startY: number;
    originPanX: number;
    originPanY: number;
  } | null>(null);

  /** The zoom level used for the locked baseline camera pose -- see design
   *  note #8, tightened by design note #26.
   *
   *  ITEM 1 FIX (design note #27, supersedes the structural calibration
   *  pass's `Math.max(width / boundsWidth, height / boundsHeight)` "fill
   *  both edge-to-edge, crop whichever axis doesn't fit" formula): now that
   *  `height` (above) is DERIVED to always match `boundsWidth`'s own aspect
   *  ratio at this `width`, fitting to `width` alone is exactly equivalent
   *  to fitting to both axes -- there is no longer a mismatched-aspect-ratio
   *  viewport to crop against, because the viewport's own aspect ratio now
   *  always matches the board's. This is what "true maximum proportional
   *  scale bounds" means concretely: the hex size that makes the board's
   *  full width exactly fill the available `width`, with zero cropping on
   *  either axis, rather than the previous pass's deliberate crop-to-fill.
   *  Toggling "Detailed View" still lets a player pan/zoom in past this for
   *  a closer look, same as before. */
  const minZoom = useMemo(() => {
    const boundsWidth = Math.max(boardContentBounds.maxX - boardContentBounds.minX, 1);
    const fitZoom = width / boundsWidth;
    // Design note #36/item 1: no upper clamp here anymore -- only the
    // degenerate-viewport floor. `fitZoom` IS "the base hex radius
    // multiplier scaled up so the map naturally occupies the widescreen
    // space," so nothing should cap it back down on a wide viewport.
    return Math.max(ABSOLUTE_MIN_ZOOM_FLOOR, fitZoom);
  }, [boardContentBounds, width]);

  /** The locked "100% view" camera pose -- see design note #13. Exactly
   *  `minZoom`, centered on the board's own bounds, i.e. the same
   *  computation the one-shot auto-fit (design note #5) already used. This
   *  is now also the camera's permanent baseline pose: with
   *  `detailedView === false`, `view` is always exactly this (drag/wheel
   *  handlers are no-ops at baseline), and toggling detailed view back off
   *  snaps the camera back to precisely this pose. */
  const fitView = useMemo<ViewTransform>(() => {
    const centerX = (boardContentBounds.minX + boardContentBounds.maxX) / 2;
    const centerY = (boardContentBounds.minY + boardContentBounds.maxY) / 2;
    return {
      zoom: minZoom,
      panX: width / 2 - centerX * minZoom,
      panY: height / 2 - centerY * minZoom,
    };
  }, [boardContentBounds, minZoom, width, height]);

  /** `false` (the default): the camera is locked at exactly `fitView` --
   *  the "100% view", the whole board framed in the viewport -- and pan/
   *  zoom input is ignored (see design note #13). `true`: the "Toggle
   *  Detailed View" button was clicked -- the camera jumped to a closer,
   *  zoomed-in pose and drag-pan/wheel-zoom are both live so the player can
   *  inspect close details manually. */
  const [detailedView, setDetailedView] = useState(false);

  /** Rail Map Overhaul (design note #42): "City Nameplate Visibility
   *  Toggle." `true` (the default): city/landmark name plates render
   *  normally, exactly as before this item. `false`: `draw()`'s every
   *  name-label pass (landmark names, gray/OO hex names, the stacked
   *  dual-city/dual-town name pairs, and the off-board zone nameplates) is
   *  skipped outright -- station tokens, revenue/value badges, and every
   *  track spline are all drawn by entirely separate passes earlier in
   *  `draw()` and are completely unaffected either way, per this item's own
   *  explicit "while maintaining station tokens, revenue badges, and track
   *  splines" wording. */
  const [showCityNames, setShowCityNames] = useState(true);

  /** The off-board hex currently under the pointer, if any -- see design
   *  note #15/item 4. Tracked independently of drag/`detailedView` state
   *  (hover works at the locked 100% baseline too, not just in detailed
   *  view): `handlePointerMove` updates this on every move, `handlePointerUp`
   *  (also wired to `onPointerLeave`) clears it. Stored as the hovered
   *  hex's own axial `(q, r)`, not a pixel/label, so it stays correct
   *  across zoom/pan changes without needing to be recomputed. */
  const [hoveredOffboardHex, setHoveredOffboardHex] = useState<{ q: number; r: number } | null>(
    null,
  );

  /** The hex currently under the pointer, if any -- see item 7 ("Muted Base
   *  Text with Hover Glow"). Deliberately separate from `hoveredOffboardHex`
   *  above (which only ever populates for an off-board zone hex, for that
   *  feature's own narrower tooltip purpose): this one is set on EVERY
   *  pointer move regardless of what kind of hex is under it, so `draw()`'s
   *  city/town/landmark name-label passes can look it up to decide whether
   *  that specific hex's label should render in its bright, bold, 100%-
   *  opaque hover style instead of its default muted/translucent one. */
  const [hoveredHexCoord, setHoveredHexCoord] = useState<{ q: number; r: number } | null>(null);

  /** The active-coordinate hover tooltip's live state -- see design note
   *  #21. `label` is the same board-label string `describeHex` would
   *  produce (a landmark's name + label, an off-board zone's name + label,
   *  or a plain board label like `"G19"`); `null` whenever the pointer
   *  isn't over a real hex of the authentic board at all, which hides the
   *  tooltip entirely rather than reporting a meaningless "off the board"
   *  string. `clientX`/`clientY` are the raw viewport pointer coordinates
   *  (NOT canvas-relative), so the DOM tooltip below can position itself
   *  with plain `position: fixed` math. `preferLeft`/`preferAbove` (design
   *  note #75) mirror `drawOffboardTooltip`'s own "ADAPTIVE QUADRANT"
   *  pattern for this file's OTHER tooltip -- reported: this one always
   *  anchored down-right of the cursor regardless of available room, so it
   *  ran off the panel for any hex near the panel's own right/bottom edge
   *  (Boston, Fall River). Set once per pointer move, from the cursor's
   *  position within the CANVAS's own bounding rect (i.e. the panel), not
   *  the browser window -- so the flip threshold tracks the panel's actual
   *  edges even if the canvas doesn't fill the whole viewport. */
  const [hoveredCoordLabel, setHoveredCoordLabel] = useState<{
    label: string;
    clientX: number;
    clientY: number;
    preferLeft: boolean;
    preferAbove: boolean;
  } | null>(null);

  /** The full draw pass: background, landmark shading, every laid tile's
   *  fill + track path, then landmark labels on top so they stay legible
   *  regardless of what's drawn beneath them. */
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    // Neutral dark charcoal workspace background -- see design note #18.
    // Everything outside the authentic 93-hex footprint (including the real
    // A13/A15 gap) simply shows this solid fill; no decorative hex fills any
    // of that space anymore.
    ctx.fillStyle = "#141414";
    ctx.fillRect(0, 0, width, height);

    ctx.translate(view.panX, view.panY);
    ctx.scale(view.zoom, view.zoom);

    // Used by every label pass below (moved up from its previous spot
    // right before the landmark labels, since the new terrain-icon labels
    // pass now needs it earlier too).
    const hexFlatWidth = Math.sqrt(3) * hexSize;

    // ---- Static board background (see design note #6) -- drawn first, so
    // everything else (landmark shading, laid tiles, labels) layers on top
    // of it. This is what makes the board visible at game launch, before
    // any tile has been laid.
    for (const hex of STATIC_BOARD_HEXES) {
      const center = axialToPixel(hex.q, hex.r, hexSize);
      drawHexPath(ctx, center, hexSize);
      // Pre-printed gray/yellow hexes override the ordinary terrain fill
      // (see design note #12) -- `hex.type` still drives the terrain icon
      // pass below regardless, so e.g. E5 gets BOTH the yellow fill AND its
      // river icon/cost label.
      ctx.fillStyle = hex.printedColor ? PRINTED_HEX_FILL[hex.printedColor] : BOARD_HEX_FILL[hex.type];
      ctx.fill();
      ctx.strokeStyle = hex.printedColor
        ? PRINTED_HEX_STROKE[hex.printedColor]
        : BOARD_HEX_STROKE[hex.type];
      ctx.lineWidth = 1;
      // Design note #26/item 3: I1/J2 (Gulf) suppress their one shared
      // interior edge here so the two hexes read as a single merged region
      // -- `drawHexEdges` re-strokes the OTHER five edges individually
      // instead of `ctx.stroke()`ing the full closed path `drawHexPath`
      // just traced above. Item 9: A9/A11 (Canadian West) get the identical
      // treatment via `CANADIAN_WEST_HIDDEN_EDGE`.
      const hiddenEdge = GULF_HIDDEN_EDGE[hex.label] ?? CANADIAN_WEST_HIDDEN_EDGE[hex.label];
      if (hiddenEdge !== undefined) {
        drawHexEdges(ctx, center, hexSize, new Set([hiddenEdge]));
      } else {
        ctx.stroke();
      }
    }

    // Design note #72: ONE claimed-slot ledger, shared by every one of this
    // render's slot-picking passes (terrain icon, restriction badge,
    // terrain-cost label, revenue badge) in their existing draw order --
    // see `claimHexSlot`'s own doc comment for why this exists (New York/
    // G19's badge, cost label, and icon all independently picking the same
    // one open corner). Declared fresh here, at the top of this whole block
    // of passes, and threaded through every one of them below.
    const claimedHexSlots = new Map<string, Set<number>>();

    // Design note #72: the SE-edge-first preference a complex hex's terrain
    // icon/cost share -- pulled out to a shared constant so both stay in
    // visual agreement about which corner/edge is "the bottom-right
    // quadrant". Design note #87: RENAMED from `DOUBLE_CITY_TERRAIN_SLOT_PREFERENCE`
    // (unchanged values) now that it's used by every complex hex's ONE
    // compound [icon+cost] badge claim, not just DoubleCity's separate
    // icon-slot claim.
    //
    // Design note #105: REORDERED, per direct request -- now leads with
    // (what the request calls) "Vertex 2" and "Vertex 4", this system's
    // own slot 9 (Lower-Right corner) and slot 11 (Lower-Left corner)
    // respectively, before falling through to the original SE-edge/
    // Bottom-Point pair (slots 3/10) as before.
    const COMPLEX_HEX_TERRAIN_SLOT_PREFERENCE: readonly number[] = [9, 11, 3, 10];

    // ---- Buildable terrain icons (design note #9; SPLIT from its own cost
    // label by design note #55's Strict Canvas Layering Hierarchy -- a cost
    // label is Layer 4 (text) content and now draws in that section further
    // below, alongside every other badge/label; only the Layer 1 terrain
    // VECTOR itself belongs this early). Mountain hexes get a brown
    // twin-peak icon, River hexes get a blue river-line icon -- both now sit
    // on the standard land fill drawn above, so they read as "buildable, at
    // a cost" rather than "impassable obstacle".
    //
    // Design note #87: a "complex" hex -- one with a city/town archetype OR
    // real live track -- no longer draws a standalone icon here AT ALL.
    // GENERALIZED from the old DoubleCity-only check, which missed the
    // SingleCity `cityDesignation` River hexes (Toledo/F4, Providence/F22,
    // Washington D.C./J14) -- those rendered a FULL-SIZE, dead-CENTERED
    // icon directly under their own revenue badge/nameplate, since
    // `isDoubleCityHex` was false for them. Every complex hex's icon is now
    // drawn together with its cost, as ONE compound badge, by the
    // terrain-cost pass further below (Layer 4) -- claiming exactly ONE
    // slot there, instead of the two separate claims (one here, one there)
    // a DoubleCity hex used to make.
    for (const hex of STATIC_BOARD_HEXES) {
      if (hex.type !== "Mountain" && hex.type !== "River") continue;
      const terrainType = hex.type;
      const center = axialToPixel(hex.q, hex.r, hexSize);
      const isComplexHex =
        archetypeForHex(mapGrid, hex.q, hex.r) !== "Plain" ||
        liveEdgesForHex(mapGrid, hex.q, hex.r).length > 0;
      if (isComplexHex) continue;
      // Rail Map Overhaul (design note #42): Hex Boundary Clipping Mask --
      // the terrain icon itself never bleeds past this hex's own border.
      withHexClip(ctx, center, hexSize, () => {
        drawTerrainIcon(ctx, terrainType, center, hexSize);
      });
    }

    // ---- Landmark dashed outline (drawn next, so a laid hub tile there,
    // and the label drawn later, both sit visibly on top of it).
    // ITEM 1 FIX (color calibration pass, "Unify All Board Yellow
    // Shades"): this loop used to ALSO re-fill each landmark hex with its
    // own translucent per-city tint (`LANDMARK_FILL` -- a ~20%-alpha red/
    // blue/green painted over that hex's ordinary cream `BOARD_HEX_FILL.Plain`
    // base from the static-background pass above), which is exactly the
    // "lighter pastel/cream" look this item reports -- visually distinct
    // from every other real pre-printed yellow hex on the board. Design
    // note #12 already established, from the same sourced data as the
    // pre-printed yellow "OO" hexes, that New York/Boston/Baltimore ARE
    // real pre-printed yellow hexes too -- so `STATIC_BOARD_HEXES`'s own
    // entries for G19/E23/I15 now carry `printedColor: "Yellow"` just like
    // every OO hex, which means the static-background pass above already
    // fills them with the exact same shared `PRINTED_HEX_FILL.Yellow`
    // constant an OO hex gets -- genuinely "the exact same... fill color"
    // this item asks for, not just a matching hex string. FACTUAL
    // CORRECTION: this item's own suggested `#FFCC00` example doesn't match
    // what this file actually uses for OO/catalog yellow anywhere --
    // `PRINTED_HEX_FILL.Yellow` is `#e8d488`, a deliberately muted
    // "cardstock" gold (design note #12), not a bright saturated color; no
    // bright/saturated yellow fill exists anywhere else in this file to
    // match. Using the literal `#FFCC00` example instead would have
    // introduced a FOURTH distinct yellow shade rather than unifying to the
    // three hexes that already share one -- so this pass points landmarks
    // at the real shared constant instead, which is what actually delivers
    // this item's own stated goal ("a uniform visual look across the map").
    // This loop's own `LANDMARK_FILL` fill is removed outright (the base
    // pass already paints the correct fill); only the dashed white outline
    // -- which still usefully flags "this hex is a landmark station",
    // unrelated to fill color uniformity -- remains here.
    for (const landmark of LANDMARK_HEXES) {
      const center = axialToPixel(landmark.q, landmark.r, hexSize);
      drawHexPath(ctx, center, hexSize);
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = "#ffffff88";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // ---- Every laid tile: fill, outline, and its decoded track path.
    // Landmark hexes (New York/Boston/Baltimore) skip the generic
    // bitmask-driven `drawTrackPath` entirely -- their authentic
    // pre-printed track is drawn unconditionally in a dedicated pass below
    // instead (see design note #6b). The fill/outline (including any
    // color-tier upgrade) still draws here either way.
    // BUG FIX ("Unify All Board Yellow Shades" follow-up -- reported: I15/
    // G19/E23 render a visibly different shade of yellow from every other
    // pre-printed yellow hex). The earlier pass fixed the STATIC background
    // fill (`STATIC_BOARD_HEXES`'s own `printedColor: "Yellow"` entries,
    // painted with `PRINTED_HEX_FILL.Yellow` = `#e8d488` before any tile is
    // laid), but this loop repaints right over that base the moment a real
    // `mapGrid.tiles` entry exists at that hex -- which, for a landmark, is
    // basically always true (a `MajorCityHub`/`DoubleCityHub` tile is
    // required there per the backend's landmark reservation, not an
    // optional player upgrade), using `ERA_TILE_FILL[catalogEntry.color]` (design note #122)
    // instead -- `TERRAIN_FILL.MajorCityHub`/`DoubleCityHub` is `#e8d9c0`, a
    // distinctly lighter/less-saturated tan than `#e8d488`, which is
    // exactly the "different shade of yellow" this reports. The same latent
    // mismatch applies to the four `YELLOW_OO_HEXES` once THEY receive a
    // laid `DoubleCityHub` tile too (tile 15) -- they just hadn't yet in
    // this game state, which is why only the landmarks showed it. Elsewhere
    // in this file, a laid tile's FILL is deliberately terrain-only, with
    // color-tier (Yellow/Green/Brown) conveyed purely through the stroke
    // below (`COLOR_TIER_STROKE`) -- never the fill -- so this keeps that
    // same convention for these hexes: any hex whose `STATIC_BOARD_HEXES`
    // entry is `printedColor: "Yellow"` (landmarks AND OO hexes alike) always
    // keeps the shared `PRINTED_HEX_FILL.Yellow` fill regardless of which
    // hub tile ends up laid there or what tier it's since been upgraded to
    // -- exactly mirroring how the pre-laid static pass already treats it,
    // and how an ordinary buildable hex's fill never encodes tier either.

    for (const tile of mapGrid.tiles) {
      const catalogEntry = TILE_CATALOG_BY_ID.get(tile.tile_id);
      const center = axialToPixel(tile.q, tile.r, hexSize);

      drawHexPath(ctx, center, hexSize);
      // Design note #122: era, and only era. No terrain keying, and no
      // printed-yellow override for landmark/OO hexes -- see `ERA_TILE_FILL`.
      ctx.fillStyle = catalogEntry ? ERA_TILE_FILL[catalogEntry.color] : "#dddddd";
      ctx.fill();
      ctx.strokeStyle = catalogEntry ? COLOR_TIER_STROKE[catalogEntry.color] : "#9a9a9a";
      ctx.lineWidth = 2;
      ctx.stroke();

      if (catalogEntry) {
        // Design note #133: the `!landmarkAt(...)` guard that used to sit
        // here is GONE, and its removal is the real fix for the reported
        // "tile 62 draws crossing track with a station dumped on the
        // intersection".
        //
        // New York, Boston and Baltimore are `LANDMARK_HEXES`. The guard
        // meant a laid tile on one of them never called `drawTrackPath` at
        // all -- so #54/#62 (NY) and #53/#61 (B) could never reach the
        // hardcoded artwork catalog no matter what was in it. What the
        // player saw on G19 instead was the PRE-PRINTED landmark track
        // from `drawLandmarkTrack`, whose two stubs run to
        // `twoNodePositions`' fixed NE/SW diagonal: a stub from the NW
        // edge sweeping down to the SW node crosses the other stub, and
        // the station sits on the crossing. Exactly the reported symptom,
        // and entirely upstream of the #62 path strings -- those are
        // provably non-crossing (see `TILE_GRAPHICS_CATALOG`'s #62 note:
        // the two arcs occupy x >= 0.366 and x <= -0.366 respectively).
        //
        // The pre-printed track pass below is now the one that yields,
        // which is the correct direction: printed artwork is what a hex
        // shows UNTIL a tile covers it.
        // Rail Map Overhaul (design note #42): Hex Boundary Clipping Mask.
        withHexClip(ctx, center, hexSize, () => {
          // Design note #121: no longer passes `tile.paths`. Double-town
          // artwork now comes from the explicit `DOUBLE_TOWN_ROUTES` table
          // keyed on `tile_id`, and every other tile was always drawn from
          // `connections` alone -- so there is nothing left for the
          // per-tile query value to feed. The contract still sends it and
          // `MapTileEntry.paths` still types it; this renderer just has no
          // use for it now.
          drawTrackPath(ctx, center, hexSize, catalogEntry, tile.orientation, false);
        });
      } else {
        // Unknown tile_id -- see design notes #2 and #118. Renders generic
        // provisional artwork rather than silently drawing nothing (or,
        // as previously, an alarming bare red "?" that read as an error
        // state). Every one of the backend's 46 real tray tiles IS in the
        // mirror above, so reaching this path means the mirror has fallen
        // behind a further backend change -- degraded, but never a crash.
        withHexClip(ctx, center, hexSize, () => {
          drawUnknownTilePlaceholder(ctx, center, hexSize, tile.tile_id);
        });
      }
    }

    // ---- Landmark pre-printed track, always drawn (see design note #6b).
    // Positioned after the per-tile loop (not folded into the earlier
    // landmark-shading pass) so a laid hub tile's own opaque fill -- drawn
    // in that loop above -- can never paint over this authentic track.
    for (const landmark of LANDMARK_HEXES) {
      // Design note #133: "always drawn" was the bug's other half. A
      // landmark's pre-printed track is its STARTING artwork, not a
      // permanent overlay -- once a real tile is laid the printed stubs are
      // physically covered by it. Continuing to draw them on top of a laid
      // #62 stacked two different renderings of New York in the same hex.
      if (hexHasLaidTile(mapGrid, landmark.q, landmark.r)) continue;
      const center = axialToPixel(landmark.q, landmark.r, hexSize);
      // Rail Map Overhaul (design note #42): Hex Boundary Clipping Mask.
      withHexClip(ctx, center, hexSize, () => {
        drawLandmarkTrack(ctx, center, hexSize, LANDMARK_TRACKS[landmark.name] ?? []);
      });
    }

    // ---- Off-board pre-printed track, always drawn (see design note #10)
    // -- symmetric with the landmark track pass above. No laid-tile loop
    // ever needs to skip over these coordinates the way it does for
    // landmarks: `hexmap::OffboardHexNotBuildable` makes it impossible for
    // `mapGrid.tiles` to ever contain an entry here in the first place.
    for (const hex of STATIC_BOARD_HEXES) {
      const edges = OFFBOARD_TRACKS[hex.label];
      if (!edges) continue;
      const center = axialToPixel(hex.q, hex.r, hexSize);
      // Rail Map Overhaul (design note #42): Hex Boundary Clipping Mask.
      withHexClip(ctx, center, hexSize, () => {
        drawOffboardTrack(ctx, center, hexSize, edges);
      });
    }

    // ---- Pre-printed gray hex track + city/town markers, always drawn
    // (see design note #12) -- symmetric with the landmark/off-board track
    // passes above.
    for (const hex of STATIC_BOARD_HEXES) {
      const grayTrack = GRAY_HEXES[hex.label];
      if (!grayTrack) continue;
      const center = axialToPixel(hex.q, hex.r, hexSize);
      // Rail Map Overhaul (design note #42): Hex Boundary Clipping Mask.
      withHexClip(ctx, center, hexSize, () => {
        drawPrintedTrack(ctx, center, hexSize, grayTrack.edges, grayTrack.marker, grayTrack.bypass);
      });
    }

    // ---- Pre-printed yellow "OO" double-city hexes, always drawn (see
    // design note #12) -- two independent station circles, no connecting
    // track (the real board prints none there either).
    for (const hex of STATIC_BOARD_HEXES) {
      if (!YELLOW_OO_HEXES.has(hex.label)) continue;
      const center = axialToPixel(hex.q, hex.r, hexSize);
      // Design note #55: Strict Hex Boundary Clipping, extended to station
      // markers -- previously only track/text calls were wrapped.
      withHexClip(ctx, center, hexSize, () => {
        drawOOCityMarkers(ctx, center, hexSize);
      });
    }

    // ---- Item 1/8 (structural calibration pass): ordinary white Town/
    // Double-Town-DESIGNATED hexes get their dark dit marker(s) drawn even
    // though they carry no printed track of their own (see
    // `BoardHex.townDesignation`'s doc comment) -- a single dark dit for a
    // Single-Town designation, two side-by-side dark dits (mirroring
    // `drawOOCityMarkers`'s two-station layout) for a Double-Town
    // designation, so a player can see at a glance which blank hexes are
    // reserved for a Town/Double-Town tile rather than ordinary track.
    for (const hex of STATIC_BOARD_HEXES) {
      if (!hex.townDesignation) continue;
      const center = axialToPixel(hex.q, hex.r, hexSize);
      // Design note #55: Strict Hex Boundary Clipping, extended to station/
      // dit markers -- previously only track/text calls were wrapped.
      withHexClip(ctx, center, hexSize, () => {
        if (hex.townDesignation === "double") {
          // Design note #54/#55/#58: Unified Diagonal Node Geometry -- the
          // SAME shared `twoNodePositions` tuple `drawOOCityMarkers` uses
          // for its two station circles, not an independently-tuned
          // side-by-side layout, so every two-node hex on the board reads
          // identically. Index 0/1 map straight onto the two `drawDitMarker`
          // calls, first slot then second, with no re-sorting.
          const [node0, node1] = twoNodePositions(center, hexSize);
          drawDitMarker(ctx, node0, hexSize * 0.85); // index 0: top-right
          drawDitMarker(ctx, node1, hexSize * 0.85); // index 1: bottom-left
        } else {
          drawDitMarker(ctx, center, hexSize);
        }
      });
    }

    // ---- Design note #34/item 2: ordinary white single-CITY-DESIGNATED
    // hexes (Toledo/Providence/Pittsburgh/Columbus/Washington/Lancaster/
    // Ottawa/Barrie) get the same "marker with no printed track" treatment
    // as the Town/Double-Town pass just above, but using the SAME
    // `drawStationCircle` (white fill, dark stroke) every other real city
    // marker in this file uses -- landmarks, `GRAY_HEXES` cities, OO
    // stations, laid `MajorCityHub` tiles -- rather than `drawDitMarker`, so
    // these read as genuine cities rather than minor town stops, matching
    // this item's own explicit "correct white station circles" ask. All
    // eight are single-city hexes on the real board (none of them a
    // double-city pair like `YELLOW_OO_HEXES`), so this is always one
    // centered circle, no offset pair needed.
    for (const hex of STATIC_BOARD_HEXES) {
      if (!hex.cityDesignation) continue;
      const center = axialToPixel(hex.q, hex.r, hexSize);
      // Design note #55: Strict Hex Boundary Clipping, extended to station
      // markers -- previously only track/text calls were wrapped.
      withHexClip(ctx, center, hexSize, () => {
        drawStationCircle(ctx, center, hexSize);
      });
    }

    // ---- Traced train routes (design note #137 / F-1). ----
    //
    // POSITION IN THE PASS ORDER IS DELIBERATE, and is the whole reason this
    // sits here rather than at the end: AFTER every track pass, so a route
    // reads as running ON the rails rather than under them; BEFORE station
    // tokens, city circles and every badge, so the overlay can never bury the
    // markers a player needs in order to read the board. A route is an
    // annotation over the map, not a replacement for it.
    drawRouteOverlays(ctx, hexSize, routeOverlays);

    // ---- Station Token markers (design note #36, extended by #44) --
    // layered on TOP of every white/gray/OO station circle drawn above. Two
    // passes: (1) a MUTED preprinted marker at each of the 8
    // `STATION_HOME_HEXES` whose matching company hasn't floated yet (or is
    // missing from
    // `publicCompanies` entirely -- e.g. before the host app's first
    // `GetGameState` query resolves), and (2) a REAL, ticker-colored marker
    // at every `station_token_hexes` entry of every company that HAS
    // floated -- which, since the home token is always index 0 there,
    // covers the home marker and any additional paid tokens together.
    {
      const companiesById = new Map<number, StationTokenCompany>();
      for (const company of publicCompanies) {
        companiesById.set(company.company_id, company);
      }

      for (const home of STATION_HOME_HEXES) {
        const company = companiesById.get(home.companyId);
        if (company && company.is_floated) continue; // drawn by the floated pass below instead
        // Station Token Badges (design note #43): a RESERVED (not-yet-
        // floated) marker on a `YELLOW_OO_HEXES` home hex (today, only
        // ERIE/E11) is drawn in neutral hex-margin space below both station
        // circles -- NOT `stationMarkerPoint`'s own left-circle anchor --
        // since real 1830 lets that corporation's President choose EITHER
        // of the two slots on its first Operating Round turn after
        // floating (module doc comment #23 in `hexmap.rs`); anchoring the
        // still-undecided reserved badge onto one specific circle would
        // misleadingly imply that slot is already committed. The ACTUAL
        // token, once floated, still renders via `stationMarkerPoint`
        // below (unchanged) -- the chain only ever records this hex's one
        // `(q, r)`, not which of the two corners was chosen, so the real
        // marker keeps its existing left-circle convention.
        const homeCenter = axialToPixel(home.q, home.r, hexSize);
        // Design note #106 (E11/Dunkirk & Buffalo only): reported the
        // reserved marker's straight-down margin point slightly overlaps
        // the bottom city marker there -- moved to Vertex 2/slot9
        // (Lower-Right), the requested destination, via `hexSlotDirection`
        // at the SAME `0.46 * hexSize` magnitude as the original
        // straight-down point (direction changed, distance from center
        // unchanged, per the user's own separate observation that these
        // offset magnitudes may already be too large -- no reason to make
        // this one any larger while fixing its direction). The other three
        // `YELLOW_OO_HEXES` (Detroit & Windsor/E5, Hamilton & Toronto/D10,
        // H18) were NOT reported and keep the original straight-down point
        // unchanged.
        const erieVertex2 = hexSlotDirection(9);
        const point =
          home.label === "E11"
            ? { x: homeCenter.x + erieVertex2.x * hexSize * 0.46, y: homeCenter.y + erieVertex2.y * hexSize * 0.46 }
            : YELLOW_OO_HEXES.has(home.label)
              ? { x: homeCenter.x, y: homeCenter.y + hexSize * 0.46 }
              : stationMarkerPoint(home.q, home.r, hexSize);
        // Design note #55: Strict Hex Boundary Clipping, extended to
        // station token markers -- previously only track/text calls were
        // wrapped.
        withHexClip(ctx, homeCenter, hexSize, () => {
          drawStationTokenMarker(
            ctx,
            point,
            hexSize,
            // Corporate Acronym Overlay guarantee (design note #45): prefer
            // a live `company.ticker` when `publicCompanies` has already
            // loaded this company, but fall back to the static
            // `stationTickerLabel` table (never an empty string) so every
            // reserved/unfloated home badge draws its acronym
            // unconditionally, regardless of query timing -- see that
            // table's own doc comment.
            company?.ticker || stationTickerLabel(home.companyId),
            stationTickerColor(home.companyId),
            true,
          );
        });
      }

      // ---- Design note #134: PER-SLOT token placement. ----
      //
      // A 2-slot city draws a pill with one ring per slot, so a token has to
      // land ON a ring rather than at the pill's centre -- two tokens at the
      // centre of one pill stack on top of each other and hide a real,
      // decision-relevant fact (whether that city still has room).
      //
      // The chain records WHICH CITY a token is in (`station_tokens`,
      // backend Audit G-12) but not which SLOT, because a slot has no
      // meaning in the rules -- capacity is a count, and two tokens in one
      // city are interchangeable. So slot order is chosen here, by ascending
      // `company_id`. That is deterministic and identical on every client
      // and every re-render, which is the property that actually matters; it
      // just isn't authoritative about which physical circle a company
      // "owns", and nothing downstream should read it as though it were.
      const occupantsByCity = new Map<string, StationTokenCompany[]>();
      for (const company of publicCompanies) {
        if (!company.is_floated) continue;
        for (const [q, r] of company.station_token_hexes) {
          const city = tokenCityIndex(company, q, r) ?? 0;
          const key = `${q},${r},${city}`;
          const bucket = occupantsByCity.get(key);
          if (bucket) bucket.push(company);
          else occupantsByCity.set(key, [company]);
        }
      }
      // `forEach`, not `for...of` over `.values()` -- tsconfig targets ES5
      // without `downlevelIteration`, so iterating a Map iterator is a
      // compile error here.
      occupantsByCity.forEach((bucket) => {
        bucket.sort((a, b) => a.company_id - b.company_id);
      });

      for (const company of publicCompanies) {
        if (!company.is_floated) continue;
        for (const [q, r] of company.station_token_hexes) {
          const laidTile = mapGrid.tiles.find((laid) => laid.q === q && laid.r === r);
          const chainCity = tokenCityIndex(company, q, r);
          const tokenCenter = axialToPixel(q, r, hexSize);

          let point: { x: number; y: number } | undefined;
          if (laidTile && chainCity !== undefined) {
            const slotPoints = tileCitySlotPoints(
              laidTile.tile_id,
              chainCity,
              laidTile.orientation,
              tokenCenter,
              hexSize,
            );
            const bucket = occupantsByCity.get(`${q},${r},${chainCity}`) ?? [];
            const slot = bucket.findIndex((entry) => entry.company_id === company.company_id);
            // A bucket longer than the city has slots means the chain and
            // this mirror disagree about capacity (see
            // `tileCitySlotCounts`' own note). Clamping to the last real
            // slot keeps the token visible and stacked rather than
            // vanishing, which is the more debuggable failure.
            point = slotPoints[Math.min(Math.max(slot, 0), slotPoints.length - 1)];
          }

          // Fallback: a pre-G-12 chain, an unknown tile, or an untiled
          // preprinted city -- all cases where there is no per-slot answer
          // to be had, so the legacy per-hex anchor is the honest one.
          const resolved = point ?? stationMarkerPoint(q, r, hexSize, laidTile);
          withHexClip(ctx, tokenCenter, hexSize, () => {
            drawStationTokenMarker(ctx, resolved, hexSize, company.ticker, stationTickerColor(company.company_id), false);
          });
        }
      }
    }

    // ---- Landmark labels, always on top. Font size responsively shrinks
    // (see design note #3b / `fitFontSize`) so the name never overflows
    // the hex's own flat-to-flat width or collides with the track above.
    // Item 3 (Three-Tier Local Deflection Stack): drawn in the hex's UPPER
    // third (negative offset), clear of the station circle locked at
    // absolute center and the terrain-cost slot in the lower third. Item 7
    // (Muted Base Text with Hover Glow): styling/hover-pop now handled by
    // `drawHexNameLabel`, shared with the gray/OO name pass below.
    // Universal Canvas Layout Engine (design note #55): a landmark's
    // nameplate anchor/format is now derived from its ARCHETYPE
    // (`archetypeForHex`), not a name check -- Boston/Baltimore
    // (SingleCity) get the shared Archetype A upper-left wedge anchor
    // (`singleNodeNameplateAnchor`), while New York (DoubleCity, per its
    // own real "two disconnected stations" `LANDMARK_TRACKS` shape) gets
    // the shared Archetype B dead-center anchor, splitting into the same
    // compact 2-line "A & B" stacked format the OO pass below uses whenever
    // a name actually contains " & " (dropping the ampersand) -- New York's
    // own name has no ampersand, so it renders as a single centered line,
    // but the ANCHOR POINT and formatting RULE are identical to every other
    // DoubleCity hex, not a special case of its own.
    for (const landmark of LANDMARK_HEXES) {
      // Rail Map Overhaul (design note #42): City Nameplate Visibility
      // Toggle -- station tokens/badges/tracks are all drawn by separate
      // passes above and are unaffected by this skip.
      if (!showCityNames) continue;
      // Dynamic City Nameplate Suppression (design note #47): once a real
      // tile is laid here, physical-board parity says its preprinted name
      // is covered -- see `hexHasLaidTile`'s own doc comment. The name
      // stays 100% available on hover (`describeHex`, extended this same
      // pass to cover every `NAMED_HEX_LABELS` city too, not just
      // landmarks/off-board zones).
      if (hexHasLaidTile(mapGrid, landmark.q, landmark.r)) continue;
      const center = axialToPixel(landmark.q, landmark.r, hexSize);
      const isHovered = Boolean(
        hoveredHexCoord && hoveredHexCoord.q === landmark.q && hoveredHexCoord.r === landmark.r,
      );
      const archetype = archetypeForHex(mapGrid, landmark.q, landmark.r);
      // Design note #78: the nameplate shows `displayName` when the landmark
      // has one (New York -> "New York & Newark"), falling back to the real
      // structural `name` otherwise -- see that field's own doc comment.
      const displayName = landmark.displayName ?? landmark.name;
      // Design note #53: Hex Boundary Clipping Mask, extended to nameplate
      // text -- `withHexClip` (design note #42) previously only wrapped
      // track-drawing calls; a nameplate positioned close to a hex's own
      // edge could still bleed its text into the neighboring hex. Now every
      // `drawHexNameLabel` call site is wrapped the same way.
      withHexClip(ctx, center, hexSize, () => {
        if (archetype === "DoubleCity") {
          const parts = displayName.split(" & ");
          if (parts.length === 2) {
            const lineMaxWidth = hexFlatWidth * 0.85;
            drawStackedNameLabel(ctx, [parts[0], parts[1]], center, lineMaxWidth, isHovered);
          } else {
            drawHexNameLabel(ctx, displayName, center, hexFlatWidth * 0.85, isHovered);
          }
        } else {
          const anchor = singleNodeNameplateAnchor(
            center,
            hexSize,
            mapGrid,
            landmark.q,
            landmark.r,
            claimedHexSlots,
          );
          drawSingleNodeNameplate(ctx, displayName, anchor, hexFlatWidth * 0.92, isHovered);
        }
      });
    }

    // ---- Pre-printed gray hex name labels (design note #12), also always
    // on top. Item 3 (Three-Tier Local Deflection Stack): UPPER third, same
    // as the landmark pass above. Item 7: styling/hover-pop via
    // `drawHexNameLabel`. Item 4 (Split Dual-City Labels): the four
    // `YELLOW_OO_HEXES` are deliberately EXCLUDED here -- a single centered
    // string through a hex with two independent stations is exactly what
    // item 4 asks to stop doing -- and get their own split-label pass right
    // below instead.
    for (const hex of STATIC_BOARD_HEXES) {
      // Rail Map Overhaul (design note #42): City Nameplate Visibility
      // Toggle.
      if (!showCityNames) continue;
      const name = NAMED_HEX_LABELS[hex.label];
      if (!name) continue;
      if (YELLOW_OO_HEXES.has(hex.label)) continue;
      // Design note #41 (Stacked Dual-Name Labels): the three double-town
      // hexes get their own split+stacked pass below, same as the OO
      // double-city hexes just below that -- skip the single-centered-
      // string treatment here for them.
      if (hex.townDesignation === "double") continue;
      // Dynamic City Nameplate Suppression (design note #47): see the
      // landmark pass above -- identical skip, applied here for every
      // remaining `NAMED_HEX_LABELS` city (Washington, Toledo, Providence,
      // Albany, Cleveland, Altoona, and the rest).
      if (hexHasLaidTile(mapGrid, hex.q, hex.r)) continue;
      const center = axialToPixel(hex.q, hex.r, hexSize);
      const isHovered = Boolean(
        hoveredHexCoord && hoveredHexCoord.q === hex.q && hoveredHexCoord.r === hex.r,
      );
      // Design note #55: Universal Canvas Layout Engine -- every hex this
      // pass ever reaches (a real GRAY single-city hex, an ordinary white
      // `cityDesignation` hex, or a real GRAY single-town hex) resolves to
      // the SingleCity or SingleTown archetype, both of which share the
      // Archetype A upper-left wedge anchor (`singleNodeNameplateAnchor`) --
      // REPLACING the previous upper-CENTER anchor. Design note #70: now
      // dynamically slot-aware, see that function's own doc comment.
      const anchor = singleNodeNameplateAnchor(center, hexSize, mapGrid, hex.q, hex.r, claimedHexSlots);
      // Design note #53: Hex Boundary Clipping Mask, extended to nameplate
      // text -- see the landmark pass above for the full reasoning.
      withHexClip(ctx, center, hexSize, () => {
        drawSingleNodeNameplate(ctx, name, anchor, hexFlatWidth * 0.92, isHovered);
      });
    }

    // ---- Item 4 (Split Dual-City Labels), STACKED (design note #41), REPOSITIONED
    // to dead-center by design note #49: the four preprinted yellow "OO"
    // double-city hexes (Detroit & Windsor, Hamilton & Toronto, Dunkirk &
    // Buffalo, Philadelphia & Trenton) get TWO independent name labels
    // instead of one string through the center -- one line directly above
    // the other. Design note #49 moved this pass from the upper-third band
    // (shared with every other name label, `center.y - hexSize * 0.58`) to
    // TRUE HEX CENTER, per the OO Double-City Layout & Geometry Refactor's
    // explicit request: with the two station circles now on a top-right/
    // bottom-left diagonal (`ooCityMarkerOffset`, was left/right), the open
    // space actually available for a nameplate is the center of the hex,
    // between the two circles, not the upper third (which the top-right
    // circle now partly occupies). Reported for the original side-by-side
    // layout: each half squeezed into less than half the hex's own width
    // (`hexFlatWidth * 0.42`), which a longer name like "Philadelphia" or
    // "Hamilton" overflowed and visibly collided with -- unreadable.
    // Stacking instead gives each line the hex's (nearly) full width to
    // itself. Each half still independently uses `drawHexNameLabel` (item
    // 7's muted/hover-glow styling), and each half's own hover state is
    // judged by the SAME shared hex coordinate -- the two stations aren't
    // separately hoverable, only the hex as a whole is.
    for (const hex of STATIC_BOARD_HEXES) {
      // Rail Map Overhaul (design note #42): City Nameplate Visibility
      // Toggle.
      if (!showCityNames) continue;
      const name = NAMED_HEX_LABELS[hex.label];
      if (!name || !YELLOW_OO_HEXES.has(hex.label)) continue;
      // Dynamic City Nameplate Suppression (design note #47): see the
      // landmark pass above -- UNCHANGED by design note #49, which only
      // repositions where this nameplate sits, not whether it persists.
      if (hexHasLaidTile(mapGrid, hex.q, hex.r)) continue;
      const [primaryName, secondaryName] = name.split(" & ");
      if (!primaryName || !secondaryName) continue; // defensive -- every real OO name is "A & B"
      const center = axialToPixel(hex.q, hex.r, hexSize);
      const isHovered = Boolean(
        hoveredHexCoord && hoveredHexCoord.q === hex.q && hoveredHexCoord.r === hex.r,
      );
      const lineMaxWidth = hexFlatWidth * 0.85;
      // Design note #84: line spacing (`NAMEPLATE_LINE_HEIGHT_PX / 2`) is
      // now derived inside `drawStackedNameLabel` itself, from the SAME
      // constant design note #51 tuned here -- no longer computed at this
      // call site.
      // Design note #53: Hex Boundary Clipping Mask, extended to nameplate
      // text -- see the landmark pass above for the full reasoning.
      withHexClip(ctx, center, hexSize, () => {
        drawStackedNameLabel(ctx, [primaryName, secondaryName], center, lineMaxWidth, isHovered);
      });
    }

    // ---- Stacked Dual-Name Labels (design note #41), part 2: the three
    // double-town hexes -- Akron & Canton (G7), Reading & Allentown (G17),
    // New Haven & Hartford (F20) -- each name TWO independent town stops
    // sharing one hex, exactly the same "A & B" shape as the four OO
    // double-city hexes above, but previously still rendered as a single
    // un-split "A & B" string via the generic single-name pass above
    // (before this pass excluded `townDesignation === "double"` from it).
    // Split and stacked the identical way the OO pass just above is, for
    // the same readability reason.
    for (const hex of STATIC_BOARD_HEXES) {
      // Rail Map Overhaul (design note #42): City Nameplate Visibility
      // Toggle.
      if (!showCityNames) continue;
      if (hex.townDesignation !== "double") continue;
      const name = NAMED_HEX_LABELS[hex.label];
      if (!name) continue;
      // Dynamic City Nameplate Suppression (design note #47): see the
      // landmark pass above.
      if (hexHasLaidTile(mapGrid, hex.q, hex.r)) continue;
      const [primaryName, secondaryName] = name.split(" & ");
      if (!primaryName || !secondaryName) continue; // defensive -- every real double-town name is "A & B"
      const center = axialToPixel(hex.q, hex.r, hexSize);
      const isHovered = Boolean(
        hoveredHexCoord && hoveredHexCoord.q === hex.q && hoveredHexCoord.r === hex.r,
      );
      const lineMaxWidth = hexFlatWidth * 0.85;
      // Design note #84: line spacing now derived inside
      // `drawStackedNameLabel` itself -- no longer computed at this call
      // site (was design note #51's same font-size-relative spacing the
      // OO pass above also used).
      // Design note #54: Compact Stacked Nameplate Centering -- moved from
      // the upper-third band (`center.y - hexSize * 0.58 +/- lineOffset`,
      // shared with every single-name label) to TRUE HEX CENTER, mirroring
      // design note #49's identical repositioning for the OO pass just
      // above. Now that the two dit markers sit on the same diagonal
      // top-right/bottom-left layout OO uses (this same design note), true
      // center is the open channel between them, not the upper third (which
      // the top-right marker now partly occupies) -- so this pass no longer
      // needs its own separate "no station circles to clear" carve-out.
      // Design note #53: Hex Boundary Clipping Mask, extended to nameplate
      // text -- see the landmark pass above for the full reasoning.
      withHexClip(ctx, center, hexSize, () => {
        drawStackedNameLabel(ctx, [primaryName, secondaryName], center, lineMaxWidth, isHovered);
      });
    }

    // ---- Red off-board revenue zone labels ("Chicago", "Gulf", etc.) plus
    // ONLY the currently active era's value, now as a circular color-coded
    // badge rather than a second text plate (design note #22) -- see design
    // note #6 / OFFBOARD_LABELS. Same responsive font-fit treatment as the
    // landmark labels above. The name plate sits above center (pushed up
    // slightly further than before -- design note #22's "explicit offset
    // padding" ask) and the value badge sits below, so both stay clear of
    // the pre-printed track stubs (design note #10) converging toward
    // center. The FULL Yellow/Green/Brown progression is still available --
    // via the floating hover tooltip card drawn later in this function, see
    // design note #15/item 4.
    //
    // Factored into a small closure (design note #26/item 3) so the SAME
    // nameplate-plus-badge drawing can be pointed at an arbitrary center --
    // needed below to draw Gulf's single merged nameplate at the I1/J2
    // midpoint instead of twice, once per hex, like every other zone here.
    //
    // Design note #78: name line(s) and revenue badge are now computed and
    // laid out as ONE combined block, anchored so the BLOCK's own vertical
    // center (not each piece independently) lands on `center` -- REPLACING
    // the previous two fixed hex-relative offsets (name pinned `hexSize *
    // 0.42` above center, badge pinned `hexSize * 0.44` below, regardless of
    // whether the name was one line or two). The badge sits a small
    // proportional gap directly beneath the name block. Also picks up the
    // shared white translucent shield (`NAMEPLATE_SHIELD_FILL`/`_HOVERED`)
    // and the standardized regular-weight `NAMEPLATE_FONT_SIZE_PX`/`_MIN_PX`
    // scale, same as every other nameplate on the board.
    const drawOffboardNameplate = (
      center: { x: number; y: number },
      offboardName: string,
      isHovered: boolean,
    ) => {
      // Rail Map Overhaul (design note #42): City Nameplate Visibility
      // Toggle gates ONLY the name text -- the value badge below is drawn
      // unconditionally, per that item's explicit "maintaining ... revenue
      // badges" requirement (so a hidden-name hex still shows a
      // badge-only block, centered on the hex).
      //
      // Design note #83: wraps onto two stacked lines ONLY for "Maritime
      // Provinces" -- the one explicitly named exception, too long to fit
      // its single hex on one line despite naming only one place -- via
      // `offboardNameplateLines` below. Every other off-board zone name
      // ("Chicago", "Gulf", "Canadian West", "Deep South") now stays a
      // single line, REVERSING #47's old "every multi-word name wraps"
      // rule: per explicit request, wrapping is reserved for names that
      // either denote two separate cities (an ampersand -- none of this
      // file's off-board zones have one) or are this one named exception.
      const nameLines: readonly string[] = showCityNames ? offboardNameplateLines(offboardName) : [];
      const nameBlockHeight = nameLines.length * NAMEPLATE_LINE_HEIGHT_PX;

      const tiers = OFFBOARD_REVENUE[offboardName];
      // Design note #66: `$` prefix DROPPED, same reasoning as
      // `drawValueBadge`'s own comment.
      const activeValue = tiers ? `${offboardValueForEra(tiers, currentEra)}` : "";
      // Design note #63/#64/#65/#66: Text-Driven Badge Sizing -- see
      // `drawValueBadge`'s own comment for the shared font/padding/floor
      // reasoning behind this exact formula. Badge text stays BOLD --
      // design note #78 scopes the regular-weight typography change to
      // nameplate TEXT, not revenue/terrain-cost badge figures.
      const offboardFontSizePx = Math.max(9, hexSize * 0.24) - 1;
      let badgeRadius = 0;
      if (tiers) {
        ctx.font = `bold ${offboardFontSizePx}px ${FONT_FAMILY_STACK}`;
        badgeRadius = badgeRadiusForLabel(ctx.measureText(activeValue), offboardFontSizePx, "square", 2, 1.5, 5);
      }
      const badgeDiameter = badgeRadius * 2;
      // Small proportional gap between the badge's own bottom and the name
      // block's own top (design note #85 flipped which sits on top) --
      // only when BOTH are actually present, so a name-only (era has no
      // revenue -- doesn't happen today, but kept correct) or badge-only
      // (`showCityNames` off) block doesn't carry a stray empty gap.
      const gap = nameLines.length > 0 && tiers ? hexSize * 0.08 : 0;
      const totalHeight = nameBlockHeight + gap + badgeDiameter;
      const blockTop = center.y - totalHeight / 2;
      // Design note #85: order flipped -- badge now occupies the TOP of the
      // combined block, name text sits directly beneath it (was the
      // reverse). `nameBlockStart` (below) marks where the name text's own
      // band begins, after the badge and the gap.
      const nameBlockStart = blockTop + badgeDiameter + gap;

      if (tiers) {
        // Centered at the TOP of the combined block.
        const badgeCenter = { x: center.x, y: blockTop + badgeRadius };

        // Design note #62: solid white square badge, dark-navy stroke --
        // off-board revenue is grouped with city hub revenue under this
        // pass's "Squares = City/Off-Board Revenue" rule.
        drawBadgeShape(ctx, badgeCenter, badgeRadius, "square");

        // Bold black text -- no halo needed on a white fill.
        ctx.fillStyle = "#000000";
        ctx.font = `bold ${offboardFontSizePx}px ${FONT_FAMILY_STACK}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(activeValue, badgeCenter.x, badgeCenter.y);
      }

      // Design note #84: a 2-line name (only "Maritime Provinces", per #83)
      // draws through `drawStackedNameLabel` for its ONE shared background
      // shield, instead of each line painting its own box independently
      // (the overlap-darkening seam that fixed). A 1-line name (every other
      // off-board zone, now, per #83) draws through the ordinary
      // `drawHexNameLabel`, same as every on-board single-line nameplate.
      // Design note #85: now positioned at `nameBlockStart` (beneath the
      // badge), not at `blockTop` (was the top of the block).
      if (nameLines.length === 2) {
        const linesCenterY = nameBlockStart + NAMEPLATE_LINE_HEIGHT_PX;
        drawStackedNameLabel(ctx, [nameLines[0], nameLines[1]], { x: center.x, y: linesCenterY }, hexFlatWidth * 0.92, isHovered);
      } else if (nameLines.length === 1) {
        const lineCenterY = nameBlockStart + NAMEPLATE_LINE_HEIGHT_PX * 0.5;
        drawHexNameLabel(ctx, nameLines[0], { x: center.x, y: lineCenterY }, hexFlatWidth * 0.92, isHovered);
      }
    };

    for (const hex of STATIC_BOARD_HEXES) {
      const offboardName = OFFBOARD_LABELS[hex.label];
      if (!offboardName) continue;
      // Design note #26/item 3 / item 9: I1/J2 (Gulf) and A9/A11 (Canadian
      // West) are each drawn with ONE shared nameplate below instead of one
      // each here.
      if (GULF_HIDDEN_EDGE[hex.label] !== undefined) continue;
      if (CANADIAN_WEST_HIDDEN_EDGE[hex.label] !== undefined) continue;
      const center = axialToPixel(hex.q, hex.r, hexSize);
      const isHovered = Boolean(
        hoveredHexCoord && hoveredHexCoord.q === hex.q && hoveredHexCoord.r === hex.r,
      );
      // Design note #55: Strict Hex Boundary Clipping, extended to
      // off-board nameplates -- previously unclipped.
      withHexClip(ctx, center, hexSize, () => {
        drawOffboardNameplate(center, offboardName, isHovered);
      });
    }

    // ---- Gulf's and Canadian West's single merged nameplates (design note
    // #26/item 3, generalized by item 9) -- drawn once, at the midpoint
    // between each zone's two hex centers, instead of the per-hex loop
    // above's usual one-nameplate-per-hex treatment. Matches the merged
    // single-region border stroke drawn in the static board background pass
    // above. Deliberately NOT wrapped in a single-hex `withHexClip` (design
    // note #55's otherwise-universal clipping requirement) -- the midpoint
    // sits ON the shared border between the two real hexes this nameplate
    // spans, by design (the same "merged region" treatment
    // `GULF_HIDDEN_EDGE`/`CANADIAN_WEST_HIDDEN_EDGE` gives their shared
    // border stroke above); clipping to either ONE hex's boundary alone
    // would incorrectly slice the text in half instead of protecting it.
    for (const [labelA, labelB, name] of [
      ["I1", "J2", "Gulf"],
      ["A9", "A11", "Canadian West"],
    ] as const) {
      const hexA = STATIC_BOARD_HEXES.find((h) => h.label === labelA);
      const hexB = STATIC_BOARD_HEXES.find((h) => h.label === labelB);
      if (hexA && hexB) {
        const centerA = axialToPixel(hexA.q, hexA.r, hexSize);
        const centerB = axialToPixel(hexB.q, hexB.r, hexSize);
        const mergedCenter = { x: (centerA.x + centerB.x) / 2, y: (centerA.y + centerB.y) / 2 };
        const isHovered = Boolean(
          hoveredHexCoord &&
            ((hoveredHexCoord.q === hexA.q && hoveredHexCoord.r === hexA.r) ||
              (hoveredHexCoord.q === hexB.q && hoveredHexCoord.r === hexB.r)),
        );
        drawOffboardNameplate(mergedCenter, name, isHovered);
      }
    }

    // ---- Terrain build-cost labels (design note #9, RELOCATED here by
    // design note #55's Strict Canvas Layering Hierarchy -- Layer 4/text
    // content, drawn after every Layer 1-3 pass rather than immediately
    // after the Layer 1 terrain icon that used to sit right next to it).
    // RECOLORED by design note #68: solid red box + white text (was the
    // same tier-colored shield box every other text element on the board
    // uses, `nameplateBoxFillFor`) -- reported: terrain costs needed to
    // read as visually distinct from revenue badges (#62-#66's white
    // squares), and a red box unambiguously reads as "cost," not
    // "revenue." Tight 2px padding/radius unchanged.
    for (const hex of STATIC_BOARD_HEXES) {
      if (hex.type !== "Mountain" && hex.type !== "River") continue;
      const terrainType = hex.type;
      // Design note #136 (F-2): the printed figure comes from the
      // coordinate-keyed mirror of `hexmap::terrain_build_fee`, so the label
      // on the board and the fee the contract charges are the same lookup.
      const terrainFee = terrainBuildFeeAt(hex.q, hex.r);
      if (terrainFee <= 0) continue;
      const costLabel = String(terrainFee);
      const center = axialToPixel(hex.q, hex.r, hexSize);
      // Design note #87: GENERALIZED past the old DoubleCity-only
      // `isDoubleCityHex` check -- see the terrain-icon pass above's own
      // comment for why (SingleCity `cityDesignation` River hexes like
      // Toledo/Providence/Washington, D.C. needed the same treatment and
      // weren't getting it). This is the SAME `isComplexHex` test that
      // pass uses, so the two always agree on which hexes are complex.
      const isComplexHex =
        archetypeForHex(mapGrid, hex.q, hex.r) !== "Plain" ||
        liveEdgesForHex(mapGrid, hex.q, hex.r).length > 0;
      // Design note #70 (13-Slot Perimeter Anchor System): Item 3's old
      // fixed "lower third" / "bottom-right quadrant" literals are now
      // resolved through the shared slot engine per Requirement 4 ("Tile
      // IDs... anchor along open outer edge faces such as the bottom
      // vertex or lower edge margins, clear of track entry points") --
      // terrain cost labels are the closest existing on-board element to
      // that description (see this task's closing summary for why no
      // actual tile-ID number is rendered on the board today), so they're
      // the one refactored against it. Default (simple hex) prefers the
      // true BOTTOM POINT (slot 10, straight down -- byte-identical
      // direction to the old fixed `{x: center.x, y: center.y +
      // hexSize*0.58}`, so the overwhelmingly common unblocked case looks
      // unchanged), then the two lower edges (4/SW, 3/SE), then the two
      // lower corners as a last resort. Any complex hex keeps its own
      // distinct bottom-RIGHT preference by starting at the SE edge (slot
      // 3) instead of the bottom point.
      // Design note #87: this is now the ONLY slot claim for a complex
      // hex's terrain icon+cost -- REPLACES the old two-claim split (one
      // here, a separate one in the icon pass above) with a SINGLE
      // `claimHexSlot` call for the whole compound badge. A simple hex's
      // claim is unchanged from before.
      const blockedCostSlots = hexBlockedSlots(mapGrid, hex.q, hex.r);
      const deadCostSlots = slotsBlockedByEdges(deadEdgesAt(hex.q, hex.r), false);
      const costOverride = resolveSlotOverride(hex.q, hex.r, "terrain");
      const costSlotPreference = withSlotReserve(
        hex.q,
        hex.r,
        "terrain",
        isComplexHex ? COMPLEX_HEX_TERRAIN_SLOT_PREFERENCE : [10, 4, 3, 11, 9],
      );
      const costSlot = claimHexSlotPreferring(
        claimedHexSlots,
        hex.q,
        hex.r,
        costOverride,
        costSlotPreference,
        blockedCostSlots,
        deadCostSlots,
      );
      const costDirection = hexSlotDirection(costSlot);
      const point = {
        x: center.x + costDirection.x * hexSize * 0.58,
        y: center.y + costDirection.y * hexSize * 0.58,
      };
      // Design note #122: the compound [icon+cost] badge's own anchor,
      // offset at `0.65` instead of the plain cost box's `0.58` above --
      // matches `drawValueBadge`'s own `REVENUE_BADGE_OFFSET` (design note
      // #109) exactly, per direct request to give the (recently shrunk,
      // design note #121) compound badge the same offset treatment the
      // revenue badge already has. Scoped to ONLY the compound badge --
      // `point` above (the plain-hex cost box's own anchor) is untouched,
      // same "only the compound badge" scope #121's own shrink used.
      const COMPOUND_BADGE_OFFSET = 0.65;
      const compoundBadgePoint = {
        x: center.x + costDirection.x * hexSize * COMPOUND_BADGE_OFFSET,
        y: center.y + costDirection.y * hexSize * COMPOUND_BADGE_OFFSET,
      };
      withHexClip(ctx, center, hexSize, () => {
        if (isComplexHex) {
          // Design note #87: ONE compound [icon+cost] pill, REPLACING the
          // plain cost-only box below for every complex hex -- the
          // standalone icon pass above already skipped drawing anything
          // for this hex, so this is the ONLY place its terrain icon
          // renders at all.
          drawTerrainCompoundBadge(ctx, terrainType, costLabel, compoundBadgePoint, hexFlatWidth * 0.85);
          return;
        }
        // Design note #68: font dropped 1pt (base `9` instead of `10`) as
        // part of the same terrain-cost-vs-revenue-badge distinction pass.
        // Design note #92: dropped another 1pt (base `8`) on top of #91's
        // tightened box padding (kept, not reverted) -- per direct request,
        // both changes now apply together.
        // Design note #95: raised back 1pt (base `9`) now that the `$`
        // prefix is gone (#94) -- freed-up horizontal room lets the number
        // read at its original size again.
        // Design note #99: raised another 1pt (base `10`), per direct
        // request.
        ctx.font = fitFontSize(ctx, costLabel, 10, hexFlatWidth * 0.85, 6, "bold");
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        // Design note #68: white text on the new solid-red box, replacing
        // the old black-on-tier-color styling.
        ctx.fillStyle = "#FFFFFF";
        // Design note #91 REVERTED (design note #97): padding tried
        // tightened 2->1 on both axes, but per direct follow-up request
        // the box is reverted back to its original 2/2 padding.
        drawLabelWithBackground(ctx, costLabel, point, {
          paddingX: 2,
          paddingY: 2,
          // Design note #68: literal solid red, this file's own established
          // "crisp" red (`drawImpassableBorderEdge`'s `#E53E3E`, design note
          // #42) -- reused here rather than inventing a new red, so the
          // board's palette stays consistent.
          fillStyle: "#E53E3E",
          cornerRadiusPx: 2,
        });
      });
    }

    // ---- City/town route-value badges (design note #26/item 5) -- a
    // small, color-coded $-value plate next to every printed destination
    // city/town circle: the three landmark cities, every pre-printed gray
    // hex city/town marker, every yellow "OO" hex, and any laid
    // SmallTown/MajorCityHub tile. FACTUAL NOTE (see design note #26): the
    // request that asked for this called the value "phase-dependent...
    // based on the current game phase tier," but `terrainBaseValue` (this
    // file's mirror of the actual `hexmap::terrain_base_value` rule
    // `RunManualRoute`'s payout math uses) is flat and terrain-only -- a
    // hex's value never changes as the game advances through color tiers.
    // The two example numbers that request gave ($10 towns / $20 base
    // cities) DO match this flat table, so they're used here verbatim; a
    // second, era-varying value for the same hex was NOT implemented,
    // since the backend has no such rule to mirror (unlike the off-board
    // zones' badges above, which genuinely are era-tiered).
    // Design note #35/items 2-3: a hex listed in `HEX_START_VALUE_OVERRIDE`
    // uses its real sourced $ figure instead of the flat terrain default --
    // and if that real figure is exactly `$0` (the four `YELLOW_OO_HEXES`,
    // and all eight `cityDesignation` hexes), the badge is skipped
    // entirely rather than drawn showing "$0", per this item's own "fully
    // hiding or removing" instruction. `undefined` (a hex absent from the
    // override table entirely) falls through to `drawValueBadge`'s own
    // unchanged flat-by-terrain default.
    for (const landmark of LANDMARK_HEXES) {
      // Design note #133: same yield as the track pass above, and for the
      // same reason one step further on -- `HEX_START_VALUE_OVERRIDE` is
      // this hex's PRINTED starting value. Once a tile is laid, the tile's
      // own chain revenue is the figure that pays (a laid #62 pays $90, not
      // New York's printed starting value), and the laid-tile badge loop
      // below now prints it.
      if (hexHasLaidTile(mapGrid, landmark.q, landmark.r)) continue;
      const override = HEX_START_VALUE_OVERRIDE[landmark.label];
      if (override === 0) continue;
      const center = axialToPixel(landmark.q, landmark.r, hexSize);
      // ADAPTIVE PLACEMENT (see `drawValueBadge`'s own doc comment): this
      // landmark's own real printed track edges, flattened out of
      // `LANDMARK_TRACKS`'s per-segment shape -- exactly the data that lets
      // New York's badge dodge its NE stub (edge 1) instead of sitting on
      // top of it, which is the G19 collision this pass was reported for.
      const landmarkEdges = (LANDMARK_TRACKS[landmark.name] ?? []).flatMap((segment) => segment.edges);
      // Design note #55: Strict Hex Boundary Clipping, extended to value
      // badges -- previously only track/text calls were wrapped.
      withHexClip(ctx, center, hexSize, () => {
        drawValueBadge(
          ctx,
          center,
          landmark.q,
          landmark.r,
          "MajorCityHub",
          hexSize,
          override,
          landmarkEdges,
          claimedHexSlots,
        );
      });
    }
    for (const hex of STATIC_BOARD_HEXES) {
      const override = HEX_START_VALUE_OVERRIDE[hex.label];
      const grayTrack = GRAY_HEXES[hex.label];
      if (grayTrack && grayTrack.marker !== "none") {
        if (override !== 0) {
          const center = axialToPixel(hex.q, hex.r, hexSize);
          withHexClip(ctx, center, hexSize, () => {
            drawValueBadge(
              ctx,
              center,
              hex.q,
              hex.r,
              grayTrack.marker === "city" ? "MajorCityHub" : "SmallTown",
              hexSize,
              override,
              grayTrack.edges,
              claimedHexSlots,
            );
          });
        }
        continue;
      }
      if (YELLOW_OO_HEXES.has(hex.label)) {
        if (override !== 0) {
          const center = axialToPixel(hex.q, hex.r, hexSize);
          withHexClip(ctx, center, hexSize, () => {
            drawValueBadge(ctx, center, hex.q, hex.r, "MajorCityHub", hexSize, override, [], claimedHexSlots);
          });
        }
      }
      // REVERTED (this pass, "Only Real-Track Towns Show Revenue" --
      // reported: every blank Town/Double-Town-designated hex shows a
      // revenue badge, when only the three hexes with REAL pre-printed
      // track -- Kingston C15, Atlantic City I19, Fall River F24, the
      // `GRAY_HEXES`/`grayTrack.marker !== "none"` branch above -- should).
      // The item 1 fix this reverts gave every blank `townDesignation` hex
      // (London E7, Burlington B20, Flint D4, Erie F10, Akron & Canton G7,
      // Reading & Allentown G17, New Haven & Hartford F20 -- see
      // `TOWN_DESIGNATED_HEXES`'s own doc comment in `hexmap.rs` for the
      // full sourcing) the same flat SmallTown/DoubleTown badge as a REAL
      // printed town, even though these seven have no printed track at all
      // -- a bare town PLACEHOLDER, not a scored destination, until a
      // player actually lays a real tile there. `hexRouteValue`'s own
      // matching fallback (used by the hover tooltip) is fixed the same way
      // just below. The backend (`pathfinding::effective_tile_and_value`)
      // was independently verified to already treat these seven correctly
      // -- `gray_preprinted_name_at` only ever matches the twelve REAL gray
      // hexes (the six cities, C15/I19/F24, and the three bare connectors),
      // never these seven blank placeholders, so a route can't pass through
      // or score value at one of them until a real tile is laid; this was a
      // frontend-only display bug, nothing to change on-chain.
      // Design note #34/item 2, values corrected by design note #35/item 3:
      // the blank single-CITY-designated hexes' real printed value is $0
      // (bare `city`/`city=revenue:0` source entries, no track), so their
      // badge is skipped entirely -- `override` is always exactly `0` for
      // every one of these eight hexes (see `HEX_START_VALUE_OVERRIDE`).
      if (hex.cityDesignation && override !== 0) {
        const center = axialToPixel(hex.q, hex.r, hexSize);
        withHexClip(ctx, center, hexSize, () => {
          drawValueBadge(ctx, center, hex.q, hex.r, "MajorCityHub", hexSize, override, [], claimedHexSlots);
        });
      }
    }
    for (const tile of mapGrid.tiles) {
      const catalogEntry = TILE_CATALOG_BY_ID.get(tile.tile_id);
      if (!catalogEntry) continue;
      if (
        catalogEntry.terrain !== "SmallTown" &&
        catalogEntry.terrain !== "DoubleTown" &&
        catalogEntry.terrain !== "MajorCityHub" &&
        catalogEntry.terrain !== "DoubleCityHub" // Tile Selection Catalog verification pass, tile 15
      ) {
        continue;
      }
      // design note #49: `BostonHub`/`NewYorkHub` are deliberately NOT
      // added to the allow-list above (even though they're now real
      // `TerrainType` members, closing the gap described in that type's own
      // doc comment) -- both terrains only ever occur at a `LANDMARK_HEXES`
      // hex, which the `landmarkAt` skip just below always catches first,
      // and `drawValueBadge`'s own `terrain` parameter is intentionally
      // typed to the narrower `SmallTown | DoubleTown | MajorCityHub |
      // DoubleCityHub` union it's always accepted -- widening the allow-list
      // above would widen `catalogEntry.terrain`'s narrowed type past what
      // `drawValueBadge` accepts for no functional benefit (this branch is
      // unreachable for a landmark hex either way).
      // Design note #133: no longer skipped for a landmark hex. The
      // landmark badge pass above now yields whenever a tile is laid, so
      // exactly one badge is drawn either way -- the printed value while the
      // hex is bare, the chain's `MapTileEntry.revenue` once it is not.
      const center = axialToPixel(tile.q, tile.r, hexSize);
      // Local `const` so the allow-list narrowing above (`catalogEntry.terrain
      // !== ...`) survives being read inside the `withHexClip` closure below
      // -- TS does not carry property-access narrowing across a function
      // boundary, only a local variable's.
      const terrain = catalogEntry.terrain;
      // ADAPTIVE PLACEMENT (see `drawValueBadge`'s own doc comment): this
      // laid tile's actual live edges at its current orientation -- the
      // same `rotateConnections`/`liveEdges` pair `drawTrackPath` itself
      // uses to draw the real track, so the badge dodges exactly what's
      // actually drawn, not the tile's unrotated base artwork.
      const tileEdges = liveEdges(rotateConnections(catalogEntry.connections, tile.orientation));
      // Design note #132: THE revenue figure, read off `MapTileEntry.revenue`
      // -- `hexmap::tile_base_value`, the same call `pathfinding::HexInfo`
      // and `operations::execute_run_manual_route` price a route through.
      // What is printed here is therefore what the contract will actually
      // pay, by construction. It is no longer computed on the frontend at
      // all; `drawValueBadge`'s existing `valueOverride` parameter is the
      // channel, so nothing about badge placement or styling changes.
      const chainRevenue = chainTileRevenue(tile);
      // `0` is a real chain answer -- plain connector track pays nothing --
      // and a `$0` badge is noise, so suppress it. `undefined` (a pre-G-11
      // contract) keeps the old terrain-bucket fallback by passing through.
      if (chainRevenue === 0) continue;
      withHexClip(ctx, center, hexSize, () => {
        drawValueBadge(ctx, center, tile.q, tile.r, terrain, hexSize, chainRevenue, tileEdges, claimedHexSlots);
      });
    }

    // ---- Canonical Tile Upgrade Restriction badges ("B"/"NY"/"OO", design
    // note #47, REVISED by design note #49, mirroring `hexmap.rs` module
    // doc comment #26/#27): Boston AND Baltimore each get a "B" corner
    // badge (Baltimore added by #49 -- real 1830 prints the "B" label on
    // both hexes, not just Boston, see #27's own Verification Status
    // paragraph), New York gets "NY", and each of the four
    // `YELLOW_OO_HEXES` gets "OO" -- see `drawRestrictionBadge`'s own doc
    // comment for the fixed-corner-and-plain-text styling. Drawn right
    // after the landmark name pass, so it layers on top of the printed
    // track/station circle beneath it but stays visually distinct from the
    // (possibly now-suppressed) name label above center.
    //
    // PERSISTENCE (design note #49, REVERSING #47): #47 gated both loops
    // below on `!hexHasLaidTile`, hiding each badge once its hex was tiled.
    // This request explicitly asks these labels to "remain visible across
    // ALL tile upgrade phases (un-tiled preprinted hexes, yellow tiles,
    // green tiles, and brown tiles)" -- the opposite of #47's own framing
    // ("before tiles are laid"). Both `hexHasLaidTile` checks are removed
    // outright; #47 itself is left in place, unedited, as the historical
    // record of the original (now-superseded) decision, per this file's own
    // convention of never silently deleting a prior pass's reasoning.
    for (const landmark of LANDMARK_HEXES) {
      const center = axialToPixel(landmark.q, landmark.r, hexSize);
      const archetype = archetypeForHex(mapGrid, landmark.q, landmark.r);
      // Badge TEXT content ("B" vs "NY") is genuine per-hex DATA (which
      // letter a real landmark prints), read the same structural way
      // `archetypeForHex` itself classifies the hex -- not a separate name
      // check -- so a DoubleCity landmark always gets "NY" and a
      // SingleCity landmark always gets "B", by construction.
      const badgeText = archetype === "DoubleCity" ? "NY" : "B";
      withHexClip(ctx, center, hexSize, () => {
        drawRestrictionBadge(
          ctx,
          center,
          hexSize,
          badgeText,
          archetype,
          mapGrid,
          landmark.q,
          landmark.r,
          claimedHexSlots,
        );
      });
    }
    for (const hex of STATIC_BOARD_HEXES) {
      if (!YELLOW_OO_HEXES.has(hex.label)) continue;
      const center = axialToPixel(hex.q, hex.r, hexSize);
      withHexClip(ctx, center, hexSize, () => {
        drawRestrictionBadge(ctx, center, hexSize, "OO", "DoubleCity", mapGrid, hex.q, hex.r, claimedHexSlots);
      });
    }

    // ---- Impassable border edges (design note #38): a fixed set of four
    // board crossings (E7/F8, D12/C11, D12/C13, C17/B16) across which track
    // may never be built, marked with a thick red bar. Drawn after every
    // tile/badge pass above so the bar is never hidden underneath a laid
    // tile's own track or fill, but before the live preview ghost tile
    // below, so a player actively previewing a placement there still sees
    // their own tentative track on top.
    for (const border of IMPASSABLE_BORDER_EDGES) {
      const center = axialToPixel(border.q, border.r, hexSize);
      drawImpassableBorderEdge(ctx, center, hexSize, border.edge);
    }

    // ---- Live preview "ghost" tile (design note #7 / item 3), drawn last
    // so it's always visible on top of everything else, but at reduced
    // opacity with a dashed outline so it clearly reads as a not-yet-
    // confirmed preview rather than a real, committed tile.
    if (previewTile) {
      const previewCatalogEntry = TILE_CATALOG_BY_ID.get(previewTile.tileId);
      const previewCenter = axialToPixel(previewTile.q, previewTile.r, hexSize);
      ctx.save();
      ctx.globalAlpha = 0.65;
      drawHexPath(ctx, previewCenter, hexSize);
      ctx.fillStyle = previewCatalogEntry ? ERA_TILE_FILL[previewCatalogEntry.color] : "#dddddd";
      ctx.fill();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = previewCatalogEntry
        ? COLOR_TIER_STROKE[previewCatalogEntry.color]
        : "#c0392b";
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.setLineDash([]);
      if (previewCatalogEntry) {
        // Rail Map Overhaul (design note #42): Hex Boundary Clipping Mask.
        withHexClip(ctx, previewCenter, hexSize, () => {
          // No query paths to pass (design note #119): `previewTile` is a
          // ghost of a tile the player is CONSIDERING, built client-side by
          // `TileSelectionPopup` from a `GetLegalTilePlacements` pairing --
          // it isn't on the board, so no `MapTileEntry` describes it.
          // `pathsForTile` falls back to the catalog mirror, which is why
          // the mirror had to carry `paths` too: a previewed double-town
          // must draw identically to the same tile once it is laid.
          drawTrackPath(ctx, previewCenter, hexSize, previewCatalogEntry, previewTile.orientation);
        });
      }
      ctx.restore();
    }

    // ---- Off-board hover tooltip (design note #15/item 4), drawn LAST so
    // it's always on top of everything else, including the ghost preview
    // tile above.
    if (hoveredOffboardHex) {
      const hex = STATIC_BOARD_HEXES.find(
        (h) => h.q === hoveredOffboardHex.q && h.r === hoveredOffboardHex.r,
      );
      const offboardName = hex ? OFFBOARD_LABELS[hex.label] : undefined;
      const tiers = offboardName ? OFFBOARD_REVENUE[offboardName] : undefined;
      if (hex && offboardName && tiers) {
        const center = axialToPixel(hex.q, hex.r, hexSize);
        // Point the card back toward the board's own interior (see
        // `drawOffboardTooltip`'s "ADAPTIVE QUADRANT" doc comment) rather
        // than always up-right, so zones near the top/right edge (Canadian
        // West, Maritime Provinces) get room to render instead of clipping
        // off the visible canvas.
        const boardCenterX = (boardContentBounds.minX + boardContentBounds.maxX) / 2;
        const boardCenterY = (boardContentBounds.minY + boardContentBounds.maxY) / 2;
        const preferLeft = center.x > boardCenterX;
        const preferBelow = center.y < boardCenterY;
        drawOffboardTooltip(
          ctx,
          center,
          hexSize,
          offboardName,
          tiers,
          currentEra,
          preferLeft,
          preferBelow,
        );
      }
    }

    // ---- Board margin labels (row letters / column numbers), drawn LAST
    // in this world-space pass -- see design note #25. Native canvas text,
    // inside the same `ctx.translate`/`ctx.scale` transform as everything
    // else above, so it automatically pans/zooms/aligns with the board.
    drawBoardMarginLabels(ctx, hexSize);

    ctx.restore();
  }, [
    // `mapGrid`, not `mapGrid.tiles` (react-hooks/exhaustive-deps).
    //
    // The body reads the WHOLE object, not just the array: `hexHasLaidTile`,
    // `archetypeForHex`, `liveEdgesForHex`, `hexBlockedSlots` and
    // `singleNodeNameplateAnchor` all take `mapGrid` itself. Depending only
    // on `.tiles` was a narrower key than the closure actually needs, which
    // is the definition of a stale-closure hazard: any change to `mapGrid`
    // that did not also replace `.tiles` would leave this callback painting
    // from the previous board.
    //
    // It costs nothing to widen. A live `GetMapGrid` response is freshly
    // parsed per poll, so `mapGrid` and `mapGrid.tiles` get new identities
    // together -- the narrow key only ever helped in the one case where a
    // parent reuses the tiles array inside a new wrapper object, which no
    // caller does.
    //
    // WHY THIS WAS INVISIBLE: `App.tsx` currently supplies
    // `useMemo(() => MOCK_MAP_GRID, [])` -- a frozen mock that never changes
    // at all, so neither the stale read nor any extra repaint could be
    // observed. The hazard only becomes real when this is wired to the live
    // poll, which is exactly when it would have been hardest to diagnose.
    //
    // NOTE FOR CALLERS: pass a STABLE `mapGrid` reference (memoised or
    // straight from the polling hook). An object literal built inline in JSX
    // gets a new identity every render and would repaint the canvas on every
    // render of the parent.
    mapGrid,
    hexSize,
    width,
    height,
    view,
    previewTile,
    currentEra,
    hoveredOffboardHex,
    hoveredHexCoord,
    boardContentBounds,
    publicCompanies,
    // Design note #137: a new route trace must repaint the canvas. Omitting
    // this from the dep list is the classic failure here -- the prop updates,
    // React re-renders, and the memoised draw callback never re-runs, so the
    // overlay silently never appears.
    routeOverlays,
    showCityNames,
  ]);

  /** Coalesces pan/zoom-driven redraws to at most one per animation
   *  frame -- see design note #4. */
  const scheduleDraw = useCallback(() => {
    if (rafHandleRef.current !== null) return;
    rafHandleRef.current = requestAnimationFrame(() => {
      rafHandleRef.current = null;
      draw();
    });
  }, [draw]);

  // Prop-driven redraw (new map data, resize, or hex size change).
  useEffect(() => {
    draw();
  }, [draw]);

  // Cancel any in-flight coalesced redraw on unmount.
  useEffect(() => {
    return () => {
      if (rafHandleRef.current !== null) {
        cancelAnimationFrame(rafHandleRef.current);
      }
    };
  }, []);

  // BUG FIX ("Tab-Switch Shrink" -- reported: returning to the Rail Map tab
  // after visiting another tab renders the board shrunk, fixed only by
  // manually clicking "Fit to Screen"). This used to be a ONE-SHOT auto-fit
  // effect (guarded by `hasAutoFitRef`, empty deps, "must run exactly once")
  // that snapped `view` to `fitView` a single time on mount. That's the bug:
  // `App.tsx` fully unmounts/remounts this component on every Rail Map <->
  // Stock Market tab switch (a plain ternary, not a CSS display toggle), so
  // "on mount" happens on every single return trip, not just first page
  // load -- and on this component's very first render after each such
  // mount, `width` is still seeded with the small `DEFAULT_WIDTH` fallback,
  // because the `ResizeObserver` above hasn't reported its real, larger
  // measurement yet (that callback fires asynchronously, after this
  // synchronous first paint). The one-shot effect fired at that exact
  // moment, captured a `fitView` computed from the too-small fallback
  // width, and then never ran again -- so `view` stayed locked to that
  // stale shrunk fit even after `measuredSize`/`width`/`fitView` corrected
  // themselves moments later once the `ResizeObserver`'s real reading
  // arrived. Clicking "Fit to Screen" happened to fix it only because that
  // handler independently re-reads the CURRENT `fitView` at click time.
  //
  // Fixed by re-running on every `fitView` change instead of once -- this
  // is also just what design note #13's own stated invariant already
  // claims ("with detailedView === false, `view` is always exactly
  // `fitView`"), now actually enforced continuously instead of only at two
  // isolated trigger points (mount, and toggling detailed view off).
  // Gated on `!detailedView` so it never fights a player's own free pan/
  // zoom while inspecting details; `handlePointerMove`/`handleWheel`
  // already independently no-op pan/zoom mutations at that baseline (see
  // design note #13), so this effect is the only writer to `view` while
  // `detailedView` is false, and cannot loop (`fitView` itself doesn't
  // depend on `view`).
  useEffect(() => {
    if (detailedView) return;
    setView(fitView);
  }, [fitView, detailedView]);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      // Always tracked, even at the locked 100% baseline (design note #13)
      // -- `dragStateRef` doubles as the click-vs-drag distance check
      // `handlePointerUp`'s click interceptor (design note #7) relies on,
      // so a genuine click must still register at baseline even though the
      // pan itself is disabled there (see `handlePointerMove` below).
      dragStateRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        originPanX: view.panX,
        originPanY: view.panY,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [view.panX, view.panY],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      // Off-board hover tracking (design note #15/item 4) -- runs on EVERY
      // pointer move, independent of drag/`detailedView` state, so the
      // tooltip works even at the locked 100% baseline and even when no
      // button is pressed at all (ordinary hover, not a drag gesture).
      // Reuses the SAME transform-undo math `handlePointerUp`'s click
      // interceptor already uses to convert a raw pointer position into an
      // axial `(q, r)`.
      const rect = event.currentTarget.getBoundingClientRect();
      const cssX = event.clientX - rect.left;
      const cssY = event.clientY - rect.top;
      const contentX = (cssX - view.panX) / view.zoom;
      const contentY = (cssY - view.panY) / view.zoom;
      const { q: hoverQ, r: hoverR } = pixelToAxial(contentX, contentY, hexSize);
      const hoveredBoardHex = STATIC_BOARD_HEXES.find((h) => h.q === hoverQ && h.r === hoverR);
      const isOffboardHover = !!(hoveredBoardHex && OFFBOARD_LABELS[hoveredBoardHex.label]);

      // Item 7 ("Muted Base Text with Hover Glow") -- tracked unconditionally,
      // unlike `hoveredOffboardHex` just below, since every labeled hex type
      // (landmark, gray/OO, plain) needs to know when it's the one under the
      // pointer, not just off-board zones.
      setHoveredHexCoord((prev) => {
        if (prev && prev.q === hoverQ && prev.r === hoverR) return prev;
        return { q: hoverQ, r: hoverR };
      });

      setHoveredOffboardHex((prev) => {
        if (isOffboardHover) {
          if (prev && prev.q === hoverQ && prev.r === hoverR) return prev;
          return { q: hoverQ, r: hoverR };
        }
        return prev === null ? prev : null;
      });

      // Active coordinate + value hover tooltip (design note #21, enriched
      // by design note #26/item 2) -- `describeHexWithValue` builds on
      // `describeHex` (still used, unchanged, by the click interceptor) so
      // the tooltip's naming still matches this file's one existing
      // hex-naming convention, with a "(Value: $X)" suffix appended. Only
      // shown over a real hex of the authentic board (a landmark or a
      // `STATIC_BOARD_HEXES` entry); the plain charcoal workspace outside
      // the board (design note #18) shows no tooltip at all.
      const hoveredLandmark = LANDMARK_HEXES.find((l) => l.q === hoverQ && l.r === hoverR);
      if (hoveredLandmark || hoveredBoardHex) {
        // Design note #75: flip toward whichever side of the PANEL (this
        // canvas's own `rect`, already computed above for the hex-hit-test)
        // still has room, mirroring `drawOffboardTooltip`'s own adaptive
        // quadrant logic -- `cssX`/`cssY` are the cursor's position relative
        // to the canvas's own top-left corner, so comparing them against
        // half the canvas's own width/height (not `window.innerWidth`/
        // `innerHeight`) keeps this correct even when the canvas doesn't
        // fill the whole browser viewport.
        setHoveredCoordLabel({
          label: describeHexWithValue(hoverQ, hoverR, mapGrid, currentEra, publicCompanies),
          clientX: event.clientX,
          clientY: event.clientY,
          preferLeft: cssX > rect.width / 2,
          preferAbove: cssY > rect.height / 2,
        });
      } else {
        setHoveredCoordLabel((prev) => (prev === null ? prev : null));
      }

      const drag = dragStateRef.current;
      if (!drag) return;
      // Design note #13: pan is only live in detailed view -- at the locked
      // 100% baseline, pointer movement is still tracked above (so
      // `handlePointerUp`'s click-vs-drag distance check, and therefore the
      // click interceptor, keeps working) but never actually updates
      // `view.panX`/`panY`.
      if (!detailedView) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      // Design note #8: rigid boundary clamping on drag displacement --
      // `clampPanToBoard` stops the raw drag-following pan the instant it
      // would pull the board's own edge past the viewport edge, rather
      // than letting the map drift into empty canvas space and relying on
      // the user to notice and drag back.
      setView((prev) => {
        const clamped = clampPanToBoard(
          drag.originPanX + dx,
          drag.originPanY + dy,
          prev.zoom,
          boardContentBounds,
          width,
          height,
        );
        return { ...prev, panX: clamped.panX, panY: clamped.panY };
      });
      scheduleDraw();
    },
    [
      detailedView,
      scheduleDraw,
      boardContentBounds,
      width,
      height,
      view.panX,
      view.panY,
      view.zoom,
      hexSize,
      // Design note #118: added so the tooltip's new real-ticker station
      // list doesn't close over a stale `publicCompanies` array from this
      // callback's first render -- station tokens are placed live during
      // play.
      publicCompanies,
      // Design note #138: `mapGrid` and `currentEra` added. The comment that
      // stood here previously acknowledged both were missing and deferred
      // them as "out of scope"; they are in scope now, and both were real
      // staleness bugs rather than lint noise.
      //
      // All three feed the SAME call -- `describeHexWithValue(hoverQ, hoverR,
      // mapGrid, currentEra, publicCompanies)` -- which builds the hover
      // tooltip, so a stale closure here does not fail loudly. It quietly
      // reports outdated numbers, indefinitely:
      //
      //   - `currentEra` is the worse of the two. It selects which off-board
      //     revenue TIER the tooltip prints, and it advances Yellow -> Green
      //     -> Brown as the game progresses. Frozen at first render, every
      //     off-board hover would show Yellow-era revenue for the entire rest
      //     of the game -- a number the contract stopped paying rounds ago.
      //   - `mapGrid` selects the hex's own value. Frozen, hovering a hex
      //     someone just upgraded reports its PRE-tile value.
      //
      // Cheap to fix: this is an `onPointerMove` prop, so a new identity just
      // swaps the handler React has attached. Nothing re-subscribes, and
      // nothing here writes state that could feed back into these deps.
      mapGrid,
      currentEra,
    ],
  );

  /** Canvas Click Interceptor (design note #7 / item 1). Pointer-up is used
   *  rather than a native `click` event so this can distinguish a genuine
   *  click from the tail end of a pan drag using the SAME `dragStateRef`
   *  already tracked for panning, instead of a second parallel gesture
   *  tracker. */
  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = dragStateRef.current;
      dragStateRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);

      if (!drag) return;
      const movedX = event.clientX - drag.startX;
      const movedY = event.clientY - drag.startY;
      const movedDistance = Math.sqrt(movedX * movedX + movedY * movedY);
      // A real pan drag almost always moves several pixels even when the
      // user "meant" to click; a small dead zone tells the two apart
      // without feeling laggy on a genuine click.
      const CLICK_MOVEMENT_THRESHOLD_PX = 4;
      if (movedDistance > CLICK_MOVEMENT_THRESHOLD_PX) return;

      const rect = event.currentTarget.getBoundingClientRect();
      const cssX = event.clientX - rect.left;
      const cssY = event.clientY - rect.top;
      // Undo `draw()`'s own `ctx.translate(view.panX, view.panY)` /
      // `ctx.scale(view.zoom, view.zoom)` to land back in the hex layer's
      // own untransformed coordinate space that `pixelToAxial` expects.
      const contentX = (cssX - view.panX) / view.zoom;
      const contentY = (cssY - view.panY) / view.zoom;
      const { q, r } = pixelToAxial(contentX, contentY, hexSize);
      const hexLabel = describeHex(q, r);

      // Tile Selection Catalog verification pass, item 1 ("Expose Selection
      // Logs"): fires the instant a player clicks a hex to open the tile
      // picker -- BEFORE the async `GetLegalTilePlacements` query below even
      // starts, since the hex's own coordinate/preprinted terrain/
      // designation is already known synchronously at this point. The
      // "complete filtered array of allowed tile_ids" this item also asks
      // for genuinely can't be logged here too: it doesn't exist yet until
      // that query resolves (this is a live on-chain query, not a local
      // filter) -- see the second `console.log` in the `.then` handler
      // below for that half, fired the moment the response actually arrives.
      // eslint-disable-next-line no-console
      console.log("[TileSelection] hex clicked", {
        hex_coordinate: { q, r, hex_label: hexLabel },
        preprinted: describeHexDesignationForLog(q, r),
      });

      onHexClick?.({ q, r, hexLabel, clientX: event.clientX, clientY: event.clientY });

      // Design note #120: this guard used to be a single condition covering
      // all four interceptor props, and it is now split in two, because the
      // props go missing for two completely different reasons that were
      // being treated identically.
      //
      // FIRST: the interceptor is switched OFF deliberately. `App.tsx`'s
      // route-select mode omits `contractAddress`/`gameId`/`protocolId` (and
      // `queryClient`) specifically so a route-point click doesn't also pop
      // the LayTile picker open underneath it -- see design note #7 and
      // App.tsx design note #11. That must keep bailing out silently.
      if (!contractAddress || gameId === undefined || protocolId === undefined) {
        return;
      }

      // SECOND: the interceptor is ON -- the caller supplied the hex's
      // identity -- but there is no chain client to ask. In practice that
      // means the app is running without a connected wallet or node, which
      // is the ordinary state of `npm start` against no backend.
      //
      // THE BUG THIS FIXES: the old combined guard returned here too, so
      // `onHexClickQuery` never fired, `App.tsx`'s `hexClickQuery` stayed
      // `null`, and its `hexClickQuery?.status === "success"` gate never
      // rendered the popup. The picker appeared completely dead on click --
      // no popup, no error, no exception, and the "[TileSelection] hex
      // clicked" log above still printing perfectly, because the handler had
      // genuinely run and then decided there was nothing to do. Nothing was
      // hanging and no promise was pending; the flow simply had no offline
      // path at all.
      //
      // Now it falls back to the local catalog mirror so the picker still
      // opens and the tray still renders. `localCatalogPlacements` filters by
      // era ONLY -- see its doc comment -- so the result is explicitly
      // provisional and goes out under `status: "offline"`, which the UI is
      // required to label as such and must not dispatch from.
      if (!queryClient) {
        const placements = localCatalogPlacements();
        // eslint-disable-next-line no-console
        console.log("[TileSelection] no chain client -- local catalog fallback", {
          hex_coordinate: { q, r, hex_label: hexLabel },
          eras: "all (browse via the picker's era tabs)",
          tile_count: new Set(placements.map((p) => p.tile_id)).size,
          contract_validated: false,
        });
        // Supersede any in-flight real query, so a response that arrives
        // after the client drops can't overwrite this offline state.
        clickQuerySeqRef.current += 1;
        onHexClickQuery?.({
          status: "offline",
          q,
          r,
          hexLabel,
          clientX: event.clientX,
          clientY: event.clientY,
          placements,
        });
        return;
      }

      const seq = ++clickQuerySeqRef.current;
      onHexClickQuery?.({
        status: "loading",
        q,
        r,
        hexLabel,
        clientX: event.clientX,
        clientY: event.clientY,
      });

      queryClient
        .queryContractSmart(contractAddress, {
          GetLegalTilePlacements: { game_id: gameId, protocol_id: protocolId, q, r },
        })
        .then((response) => {
          // Stale-response guard: a rapid earlier click's request can
          // resolve after a newer click's -- only the latest matters.
          if (clickQuerySeqRef.current !== seq) return;

          // Tile Selection Catalog verification pass, item 1 (continued):
          // the "complete filtered array of allowed tile_ids" half of this
          // item's log, fired now that the upgrade catalog module
          // (`hexmap::legal_tile_placements` on-chain) has actually
          // returned it -- each entry is a `(tile_id, orientation)` pairing
          // the live `LayTile` call would currently accept at this hex.
          // eslint-disable-next-line no-console
          console.log("[TileSelection] legal placements resolved", {
            hex_coordinate: { q, r, hex_label: hexLabel },
            allowed_placements: (response as LegalTilePlacementsResponse).placements,
          });

          onHexClickQuery?.({
            status: "success",
            q,
            r,
            hexLabel,
            clientX: event.clientX,
            clientY: event.clientY,
            response: response as LegalTilePlacementsResponse,
          });
        })
        .catch((error: unknown) => {
          if (clickQuerySeqRef.current !== seq) return;
          const message = error instanceof Error ? error.message : String(error);
          onHexClickQuery?.({
            status: "error",
            q,
            r,
            hexLabel,
            clientX: event.clientX,
            clientY: event.clientY,
            message,
          });
        });
    },
    [
      view.panX,
      view.panY,
      view.zoom,
      hexSize,
      queryClient,
      contractAddress,
      gameId,
      protocolId,
      onHexClick,
      onHexClickQuery,
      // Design note #125 dropped `currentEra` from here: the offline
      // fallback no longer filters by era, so the handler has nothing
      // era-dependent left to close over. Era browsing is now a view control
      // inside `TileSelectionPopup` instead.
    ],
  );

  /** Design note #67: Scroll-Wheel Zoom Disabled. Previously zoomed the
   *  board around the cursor (`deltaY < 0` -> `factor = 1.1`, else `1 /
   *  1.1`, the exact same `setView`/`clampPanToBoard` update the "+"/"-"
   *  camera buttons below still use) -- reported: the ONLY way to zoom
   *  should be those manual buttons, not an incidental scroll-wheel
   *  gesture while the cursor happens to be over the map. The zoom
   *  math/state update is REMOVED entirely (not merely gated off, so
   *  there's no dead `minZoom`/`MAX_ZOOM_MULTIPLIER`/`clampPanToBoard`
   *  zoom-on-wheel path left to accidentally re-enable) -- `handleWheel`
   *  now does exactly one thing: `preventDefault()`, still unconditional,
   *  still purely to stop the page itself from scrolling while the cursor
   *  is over the canvas (design note #13's own reasoning, UNCHANGED by
   *  this pass -- that's a scroll-containment concern, not a zoom one). */
  const handleWheel = useCallback((event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
  }, []);

  /** "+"/"-" camera overlay button handler -- see design note #17.
   *  Zooms by `factor` around the canvas's own screen-space center (a
   *  button click has no cursor position to anchor on, unlike
   *  `handleWheel`'s mouse-anchored zoom), clamped to
   *  `[minZoom, minZoom * MAX_ZOOM_MULTIPLIER]` (design note #36/item 1 --
   *  relative to `minZoom`, not the old absolute `MAX_ZOOM`)
   *  and pan-clamped to the board exactly like every other zoom path here.
   *  If the camera is still at the locked `fitView` baseline
   *  (`detailedView === false`), this ALSO flips `detailedView` on -- these
   *  buttons are meant to work standalone, without first requiring a
   *  separate "Toggle Detailed View" click, so the very first "+"/"-"
   *  press starts from `fitView`'s own zoom/pan (captured via the
   *  `detailedView` dependency below) rather than being a no-op. */
  const handleZoomStep = useCallback(
    (factor: number) => {
      setDetailedView(true);
      setView((prev) => {
        const baseView = detailedView ? prev : fitView;
        const nextZoom = Math.min(minZoom * MAX_ZOOM_MULTIPLIER, Math.max(minZoom, baseView.zoom * factor));
        // Keep the point currently at the canvas's own screen-space center
        // fixed in world space while zooming, so repeated +/- presses zoom
        // in/out around the middle of the view rather than drifting.
        const centerWorldX = (width / 2 - baseView.panX) / baseView.zoom;
        const centerWorldY = (height / 2 - baseView.panY) / baseView.zoom;
        const clamped = clampPanToBoard(
          width / 2 - centerWorldX * nextZoom,
          height / 2 - centerWorldY * nextZoom,
          nextZoom,
          boardContentBounds,
          width,
          height,
        );
        return { zoom: nextZoom, panX: clamped.panX, panY: clamped.panY };
      });
      scheduleDraw();
    },
    [detailedView, fitView, minZoom, boardContentBounds, width, height, scheduleDraw],
  );
  const handleZoomIn = useCallback(() => handleZoomStep(1.25), [handleZoomStep]);
  const handleZoomOut = useCallback(() => handleZoomStep(1 / 1.25), [handleZoomStep]);

  /** "Fit to Screen" camera overlay button handler -- see design note #17
   *  (button removed and consolidated per design note #42, handler logic
   *  unchanged). Unconditionally snaps the camera back to exactly `fitView`
   *  and re-locks it (`detailedView` false) -- idempotent and always
   *  available as its own explicit action, regardless of whether the camera
   *  got to its current pose via drag/wheel or the "+"/"-" buttons above. */
  const handleFitToScreen = useCallback(() => {
    setDetailedView(false);
    setView(fitView);
    scheduleDraw();
  }, [fitView, scheduleDraw]);

  /** The pointer has left the canvas entirely -- clears the off-board hover
   *  tooltip (design note #15/item 4) in addition to `handlePointerUp`'s own
   *  drag-release handling, since `handlePointerMove` (the only other place
   *  that updates `hoveredOffboardHex`) stops firing once the pointer is
   *  outside the element. */
  const handlePointerLeave = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      setHoveredOffboardHex(null);
      setHoveredCoordLabel(null);
      setHoveredHexCoord(null);
      handlePointerUp(event);
    },
    [handlePointerUp],
  );

  return (
    <div
      ref={containerRef}
      style={{
        position: "relative",
        // Design note #19: with no explicit `widthProp`, this wrapper
        // flex-fills its host pane's WIDTH (`ResizeObserver` above measures
        // the pixel width that resolves to); an explicit override keeps the
        // old fixed-pixel behavior.
        width: widthProp ?? "100%",
        // ITEM 1 FIX (design note #27): was `heightProp ?? "100%"` -- a
        // percentage height only ever resolves against an ANCESTOR's own
        // definite height, which no longer exists once `App.tsx` (design
        // note #13) stops imposing one. This is now the same computed pixel
        // `height` the `<canvas>` below uses (derived from the board's own
        // aspect ratio, not measured), so this wrapper's real DOM box is
        // exactly as tall as its content actually needs -- letting that
        // height propagate straight up through every unconstrained ancestor
        // to the page itself.
        height: `${height}px`,
      }}
      className={className}
    >
      {/* Design note #25: the map canvas is once again the direct, single
          child here -- no nested wrapper div. Design notes #20/#23/#24's DOM
          overlay/frame detour is gone entirely: the row/column margin
          labels are now drawn NATIVELY on the canvas itself (see
          `drawBoardMarginLabels`, called at the end of `draw()`'s
          world-space pass), so there's no longer any separate DOM element
          that needs to be sized or positioned relative to the canvas at
          all. */}
      <canvas
        ref={canvasRef}
        style={{ width, height, touchAction: "none", cursor: detailedView ? "grab" : "default" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onWheel={handleWheel}
      />
      {/* Active coordinate + value hover tooltip -- see design note #21,
          enriched by design note #26/item 2 (drops the old "Hovering: "
          prefix so the on-screen text matches that item's own literal
          "G19: New York (Value: $20)" example exactly). Positioned with
          plain `position: fixed` viewport coordinates (not relative to
          this wrapper), so it tracks the raw cursor position exactly.
          Design note #75: ADAPTIVE QUADRANT, mirroring `drawOffboardTooltip`
          -- reported, this always anchored down-right of the cursor
          regardless of room, running off the panel for hexes near its
          right/bottom edge (Boston, Fall River). `preferLeft`/`preferAbove`
          (computed in `handlePointerMove` from the cursor's position within
          the canvas's own panel) flip which corner of the tooltip sits at
          the cursor, using `right`/`bottom` (viewport-anchored, same as
          `left`/`top`) instead of just always growing down-right. */}
      {hoveredCoordLabel && (
        <div
          style={{
            ...HOVER_TOOLTIP_STYLE,
            ...(hoveredCoordLabel.preferLeft
              ? { right: window.innerWidth - hoveredCoordLabel.clientX + 14 }
              : { left: hoveredCoordLabel.clientX + 14 }),
            ...(hoveredCoordLabel.preferAbove
              ? { bottom: window.innerHeight - hoveredCoordLabel.clientY + 14 }
              : { top: hoveredCoordLabel.clientY + 14 }),
          }}
        >
          {hoveredCoordLabel.label}
        </div>
      )}
      {/* Rail Map Overhaul (design note #42): "Clean Up Control Overlay
          Overlaps" -- the old separate "Toggle Detailed View" button
          (design note #13) is removed entirely, and the former "+"/"-"/
          "Fit to Screen" bottom-right stack is folded into this single
          floating top-right panel alongside the new City Names toggle, so
          there's exactly ONE control cluster instead of two. */}
      <div style={MAP_CONTROLS_PANEL_STYLE}>
        <button
          type="button"
          onClick={() => setShowCityNames((prev) => !prev)}
          style={CAMERA_CONTROL_BUTTON_STYLE}
          aria-label={showCityNames ? "Hide city names" : "Show city names"}
        >
          {showCityNames ? "Hide City Names" : "Show City Names"}
        </button>
        <button type="button" onClick={handleZoomOut} style={CAMERA_CONTROL_BUTTON_STYLE} aria-label="Zoom out">
          -
        </button>
        <button type="button" onClick={handleZoomIn} style={CAMERA_CONTROL_BUTTON_STYLE} aria-label="Zoom in">
          +
        </button>
        <button
          type="button"
          onClick={handleFitToScreen}
          style={CAMERA_CONTROL_BUTTON_STYLE}
          aria-label="Fit to screen"
        >
          Fit to Screen
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Drawing helpers                                                    */
/* ------------------------------------------------------------------ */

/** Traces (but doesn't fill/stroke) the six-cornered hex outline centered
 *  at `center`, ready for the caller to `ctx.fill()`/`ctx.stroke()`. */
function drawHexPath(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
): void {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const corner = pointOnCircle(center, size, cornerAngleRad(i));
    if (i === 0) {
      ctx.moveTo(corner.x, corner.y);
    } else {
      ctx.lineTo(corner.x, corner.y);
    }
  }
  ctx.closePath();
}

/** Rail Map Overhaul (design note #42): runs `draw` with the canvas clipped
 *  to hex `(center, size)`'s own 6-vertex polygon (`drawHexPath`) for its
 *  entire duration -- the "Hex Boundary Clipping Mask" requirement, so
 *  whatever `draw` paints (a track spline, a terrain icon) can never bleed
 *  past this hex's own border into a neighboring hex, even if a curve's
 *  control point ends up slightly outside the hex's apothem. `ctx.save()`/
 *  `ctx.clip()`/`ctx.restore()`, exactly as the requirement names it --
 *  `save`/`restore` scope the clip region to just this one call, so it never
 *  leaks into whatever the next hex's own pass draws. */
function withHexClip(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
  draw: () => void,
): void {
  ctx.save();
  drawHexPath(ctx, center, size);
  ctx.clip();
  draw();
  ctx.restore();
}

/** Rail Map Overhaul (design note #42): the unit vector pointing from hex
 *  edge `edgeIndex`'s own midpoint straight toward hex center -- i.e. that
 *  edge's own INWARD face-normal. `edgeAngleRad(edgeIndex)` already gives
 *  the OUTWARD direction from center to the edge midpoint (see
 *  `edgePoint`'s own use of it throughout this file), so the inward normal
 *  is just that angle plus 180 degrees. Used by `bezierTrackSegment` below
 *  to satisfy the "Perpendicular Edge Normals" requirement: a track
 *  endpoint sitting on a real hex edge gets its Bezier control point
 *  projected along exactly this direction, so the curve's tangent AT that
 *  edge is perpendicular to the edge itself (a true 90-degree crossing),
 *  regardless of which direction the curve bends once inside the hex. */
function edgeInwardNormal(edgeIndex: number): { x: number; y: number } {
  const angle = edgeAngleRad(edgeIndex) + Math.PI;
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

/** Rail Map Overhaul (design note #42): strokes one cubic-Bezier track
 *  curve from `from` to `to` via `ctx.bezierCurveTo` -- the "Smooth Bezier
 *  Track Splines" / "City Connector Curves" requirement, replacing this
 *  file's previous `quadraticCurveTo`-based track curves throughout.
 *
 *  `fromNormal`/`toNormal` are each endpoint's own `edgeInwardNormal` when
 *  that endpoint sits on a real hex edge, or `null` when it's a hex-center
 *  station node (which has no single face to be perpendicular to). Each
 *  provided normal projects that endpoint's own Bezier control point
 *  INWARD along the edge's own normal by `hexSize * controlFraction`
 *  (25%-35% of the hex radius, per the same requirement -- default `0.3`)
 *  -- since a cubic Bezier's tangent at each endpoint points directly at
 *  its own adjacent control point, this guarantees the curve crosses that
 *  edge perpendicular to it, satisfying "every track touching a hex face
 *  must enter/exit at a 90-degree normal angle" exactly. An endpoint with
 *  no normal (a hex-center station) falls back to the straight from->to
 *  chord direction instead, so the curve still eases smoothly through the
 *  shared station node -- "sweep gracefully through station nodes without
 *  sharp hairpin kinks or V-angles" -- rather than kinking at a
 *  zero-length control point. */
function bezierTrackSegment(
  ctx: CanvasRenderingContext2D,
  from: { x: number; y: number },
  to: { x: number; y: number },
  hexSize: number,
  fromNormal: { x: number; y: number } | null,
  toNormal: { x: number; y: number } | null,
  controlFraction = 0.3,
): void {
  const reach = hexSize * controlFraction;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const n1 = fromNormal ?? { x: dx / len, y: dy / len };
  const n2 = toNormal ?? { x: -dx / len, y: -dy / len };
  const cp1 = { x: from.x + n1.x * reach, y: from.y + n1.y * reach };
  const cp2 = { x: to.x + n2.x * reach, y: to.y + n2.y * reach };
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, to.x, to.y);
  ctx.stroke();
}

/** Strokes only SOME of a hex's six border edges -- design note #26/item 3.
 *  Edge `i` runs from corner `i` to corner `(i + 1) % 6` (matching
 *  `cornerAngleRad`'s own doc comment). Unlike `drawHexPath` (one closed
 *  6-sided path, always all-or-nothing), each included edge here is its own
 *  independent 2-point subpath, so a caller can omit exactly one shared
 *  edge (e.g. the Gulf I1/J2 interior seam) while still drawing the other
 *  five normally. */
function drawHexEdges(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
  excludeEdges: ReadonlySet<number>,
): void {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    if (excludeEdges.has(i)) continue;
    const a = pointOnCircle(center, size, cornerAngleRad(i));
    const b = pointOnCircle(center, size, cornerAngleRad((i + 1) % 6));
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
}

/** Strokes a single thick red bar across hex `(q, r)`'s edge `edge` --
 *  `IMPASSABLE_BORDER_EDGES`' own visual marker (design note #38) for a
 *  board crossing track may never be built over. Deliberately its own
 *  standalone stroke call (sets and restores its own `strokeStyle`/
 *  `lineWidth`/`lineCap`, like `drawLandmarkTrack`'s own per-segment style
 *  reset) rather than reusing `drawHexEdges`' multi-edge/shared-style API,
 *  since this always draws exactly one edge with its own fixed heavy red
 *  style, independent of whatever track style is active around it.
 *
 *  Rail Map Overhaul (design note #42): recolored to the requested crisp
 *  `#E53E3E` (was a duller `#c0392b`) and clamped to a literal 3px-4px
 *  width -- `Math.min(4, Math.max(3, size * 0.1))`, replacing the old
 *  unclamped `Math.max(5, size * 0.16)` floor, which read wider than an
 *  ordinary barrier bar at most hex sizes and had no upper bound at all.
 *  Drawn flush along the shared edge's own two corner vertices (`a`/`b`
 *  below, straight off `cornerAngleRad`) -- exactly `IMPASSABLE_BORDER_EDGES`'
 *  own edge, not a separately-computed/offset line -- so at this reduced
 *  width it sits flush on the hex border without visibly overshooting
 *  either corner. */
function drawImpassableBorderEdge(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
  edge: number,
): void {
  const a = pointOnCircle(center, size, cornerAngleRad(edge));
  const b = pointOnCircle(center, size, cornerAngleRad((edge + 1) % 6));
  ctx.save();
  ctx.strokeStyle = "#E53E3E";
  ctx.lineWidth = Math.min(4, Math.max(3, size * 0.1));
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.restore();
}

/** Decodes `entry`'s base connection bitmask against `orientation` (via
 *  `rotateConnections`, bit-for-bit identical to
 *  `hexmap::rotate_connections`) and draws the resulting track path -- see
 *  design note #3 for the edge-pairing convention this uses. */
/** Design note #52: the two station points for a genuine two-city tile
 *  (`NewYorkHub`, `DoubleCityHub`) -- shared by both the per-city
 *  track-curve rendering in `drawTrackPath` and that same function's own
 *  station-circle placement just below, so a laid tile's track and circles
 *  can never drift apart from each other. Index order matches
 *  `TileCatalogEntry.cityGroups`' own order (city A first, city B second).
 *  Returns `[center, center]` for anything else -- defensive; `cityGroups`
 *  is only ever set on these two terrain kinds.
 *
 *  Design note #56: `NewYorkHub` previously used its own stale, non-
 *  diagonal "side-by-side" formula (`center.x ± size * 0.28`, `center.y`
 *  unchanged) -- left over from before the Universal Canvas Layout Engine
 *  and never updated to the shared diagonal convention, and itself an
 *  unrelated left/right inversion risk on top of the reported
 *  `stationMarkerPoint` bug. New York's real `cityGroups` (city A = edges
 *  E+NE, city B = edges NW+W, see `hexmap.rs`) sit on the right and left
 *  halves of the hex respectively, which the canonical Top-Right/NE
 *  (`+doubleNodeOffset`) vs. Bottom-Left/SW (`-doubleNodeOffset`) diagonal
 *  nodes both satisfy and directionally match -- so `NewYorkHub` now merges
 *  into the exact same branch as `DoubleCityHub`, giving every laid
 *  two-city tile (New York and all four OO variants) identical Node
 *  0/Node 1 coordinates and zero per-terrain-name geometry divergence. */
function twoCityStationPoints(
  terrain: TerrainType,
  center: { x: number; y: number },
  size: number,
): [{ x: number; y: number }, { x: number; y: number }] {
  if (terrain === "DoubleCityHub" || terrain === "NewYorkHub") {
    return twoNodePositions(center, size);
  }
  return [center, center];
}

/* ------------------------------------------------------------------ */
/* Canonical double-town artwork -- design note #121                    */
/* ------------------------------------------------------------------ */

/** How one town's track runs across the tile, and where its dit sits.
 *  BASE (pre-rotation) edge numbers, same space as `TileCatalogEntry`'s
 *  `connections`/`paths`. */
interface DoubleTownRoute {
  /** The two hex edges this town's track joins. */
  edges: readonly [number, number];
  /** Where to put this town's marker.
   *
   *  `"midpoint"` evaluates the drawn track at its own halfway point, so
   *  the dit is guaranteed to sit ON the track whatever shape it took --
   *  which for a straight is hex centre, and for a curve is the middle of
   *  the arc.
   *
   *  `"alongTrack"` exists solely for #55, whose two tracks are BOTH
   *  straights and therefore both have their midpoint at dead centre. It
   *  slides each dit out along its own straight by `fraction` of the
   *  apothem, toward `towardEdge`. Because it moves the MARKER rather than
   *  the track, the X stays perfectly straight. */
  /** Where this town's marker sits, as the parameter `t` along its OWN
   *  drawn track: `0` is the `edges[0]` end, `1` is the `edges[1]` end,
   *  `0.5` is the middle. Design note #123.
   *
   *  Superseded a `"midpoint"` rule that put every dit at `t = 0.5`. That
   *  is exactly the wrong place on these tiles: the middle of a track is
   *  where the OTHER track crosses it. On #69 the gentle curve's midpoint
   *  landed precisely on the straight, so its dit sat on the intersection
   *  and read as a blob rather than a town. Pushing each dit out along its
   *  own arm is also what the printed tiles do -- the circles sit clear of
   *  the crossing, toward the edges. */
  ditAt: number;
}

/** The five real 1830 double-town tiles, drawn explicitly rather than
 *  derived -- design note #121.
 *
 *  There are exactly five of these in the whole game and there will never
 *  be a sixth, so an explicit table beats a general algorithm: it is
 *  readable as "this is what #55 looks like", it cannot produce a surprise
 *  on some orientation nobody tested, and each entry can be checked against
 *  a photograph of the physical tile.
 *
 *  Shape per entry, by edge separation (`d = min(|a-b|, 6-|a-b|)`):
 *    #1  {0,4} + {1,3} -- two gentle curves (d=2, d=2)
 *    #2  {0,3} + {1,2} -- straight + sharp curve (d=3, d=1)
 *    #55 {0,3} + {1,4} -- two straights: the X (d=3, d=3)
 *    #56 {0,2} + {1,3} -- two gentle curves (d=2, d=2)
 *    #69 {0,3} + {2,4} -- straight + gentle curve (d=3, d=2)
 *
 *  `edges` duplicates `hexmap::TILE_CATALOG`'s path data on purpose, so
 *  this table reads standalone. The dev-mode assertion under
 *  `TILE_CATALOG_BY_ID` cross-checks the two, so the duplication cannot
 *  silently drift. */
const DOUBLE_TOWN_ROUTES: Readonly<Record<number, readonly DoubleTownRoute[]>> = {
  1: [
    { edges: [0, 4], ditAt: 0.80 },
    { edges: [1, 3], ditAt: 0.20 },
  ],
  2: [
    { edges: [0, 3], ditAt: 0.80 },
    { edges: [1, 2], ditAt: 0.20 },
  ],
  // #55 -- the X. Both arms are straights, so their midpoints coincide at
  // the crossing; the two dits go out along opposite arms instead. The
  // TRACK is still drawn dead straight, which is the whole point.
  55: [
    { edges: [0, 3], ditAt: 0.20 },
    { edges: [1, 4], ditAt: 0.80 },
  ],
  56: [
    { edges: [0, 2], ditAt: 0.20 },
    { edges: [1, 3], ditAt: 0.80 },
  ],
  // #69 -- the tile that prompted design note #123. Its gentle curve
  // crosses the straight at the straight's own midpoint, so `t = 0.5` put
  // one dit squarely on the intersection. Both are now off it.
  69: [
    { edges: [0, 3], ditAt: 0.38 },
    { edges: [2, 4], ditAt: 0.20 },
  ],
};

// Drift tripwire for the table above (design note #121). `DOUBLE_TOWN_ROUTES`
// restates each double-town's edge pairs so it reads standalone, which makes
// it a second copy of data `TILE_CATALOG` already holds. This is what stops
// the two silently diverging: if the backend ever re-sources a tile's
// pairing, the artwork table has to move with it, or that tile keeps
// rendering the old shape while every other consumer uses the new one.
// Dev-only, never throws.
if (process.env.NODE_ENV !== "production") {
  const normalize = (pairs: ReadonlyArray<readonly [number, number]>) =>
    JSON.stringify(
      pairs.map(([a, b]) => (a <= b ? [a, b] : [b, a])).sort((x, y) => x[0] - y[0] || x[1] - y[1]),
    );
  for (const entry of TILE_CATALOG) {
    const routes = DOUBLE_TOWN_ROUTES[entry.tileId];
    if (entry.terrain === "DoubleTown" && !routes) {
      // eslint-disable-next-line no-console
      console.warn(
        `[HexGridRenderer] DoubleTown tile #${entry.tileId} has no DOUBLE_TOWN_ROUTES entry -- ` +
          "it will fall through to the generic multi-spur fan. Add its canonical artwork.",
      );
      continue;
    }
    if (!routes || !entry.paths) continue;
    const fromTable = normalize(routes.map((route) => route.edges));
    const fromCatalog = normalize(entry.paths);
    if (fromTable !== fromCatalog) {
      // eslint-disable-next-line no-console
      console.warn(
        `[HexGridRenderer] DoubleTown tile #${entry.tileId} artwork/catalog mismatch: ` +
          `DOUBLE_TOWN_ROUTES says ${fromTable}, TILE_CATALOG says ${fromCatalog}.`,
      );
    }
  }
}

/** Draws one double-town track between two edges and returns the point
 *  halfway along whatever it drew -- design note #121.
 *
 *  Two shapes, chosen by how far apart the edges are:
 *
 *  OPPOSITE edges (`d === 3`) get a literal `lineTo`. Not a Bezier that
 *  happens to look straight -- an actual straight segment, so #55's X can
 *  never bow by a fraction of a pixel. Its halfway point is hex centre.
 *
 *  Anything else gets ONE cubic Bezier whose control points sit on each
 *  endpoint's own inward normal, `hexSize * 0.3` in. That is the file's
 *  existing `bezierTrackSegment` reach, and it is deliberately gentle: the
 *  tangent leaves each edge perpendicular, as real printed track does, and
 *  the curve then flows to the other edge without being dragged toward any
 *  intermediate node. A 60-degree pair reads as a tight corner curve and a
 *  120-degree pair as a shallow bow, purely from the geometry -- no
 *  per-shape fudging. */
function drawDoubleTownRoute(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
  apothem: number,
  edgeA: number,
  edgeB: number,
): (t: number) => { x: number; y: number } {
  const from = pointOnCircle(center, apothem, edgeAngleRad(edgeA));
  const to = pointOnCircle(center, apothem, edgeAngleRad(edgeB));
  const separation = Math.min(Math.abs(edgeA - edgeB), 6 - Math.abs(edgeA - edgeB));

  if (separation === 3) {
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    // Straight line: plain linear interpolation, exact.
    return (t) => ({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
  }

  const reach = size * 0.3;
  const normalA = edgeInwardNormal(edgeA);
  const normalB = edgeInwardNormal(edgeB);
  const cp1 = { x: from.x + normalA.x * reach, y: from.y + normalA.y * reach };
  const cp2 = { x: to.x + normalB.x * reach, y: to.y + normalB.y * reach };

  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, to.x, to.y);
  ctx.stroke();

  // The standard cubic basis, evaluated on the curve JUST DRAWN -- an exact
  // point on it, not an approximation, so a dit placed at any `t` can never
  // drift off its own track. Design note #123 needs arbitrary `t`, not just
  // the midpoint, to push each town clear of where the other track crosses.
  return (t) => {
    const u = 1 - t;
    return {
      x: u * u * u * from.x + 3 * u * u * t * cp1.x + 3 * u * t * t * cp2.x + t * t * t * to.x,
      y: u * u * u * from.y + 3 * u * u * t * cp1.y + 3 * u * t * t * cp2.y + t * t * t * to.y,
    };
  };
}

/** True when `paths` are pairwise edge-DISJOINT, i.e. the tile carries
 *  several independent runs of track rather than one shared junction --
 *  design note #122.
 *
 *  This is the whole basis for choosing a rendering, and it is read off the
 *  catalog rather than guessed. A junction tile's path list names every
 *  through-route across a shared node: #14 lists all six pairs among its
 *  four edges, #63 all fifteen among its six, #39 all three among its
 *  three. Drawing those as separate curves would be spaghetti -- they mean
 *  "everything meets in the middle", which is exactly the fan. A disjoint
 *  list means the opposite: #16's `[[0,2],[1,3]]` is two tracks that never
 *  touch, and fanning them into one node invents a connection the tile does
 *  not have. */
function pathsAreDisjoint(paths: ReadonlyArray<readonly [number, number]>): boolean {
  const seen = new Set<number>();
  for (const [a, b] of paths) {
    if (a === b) return false; // terminal spur -- handled by `cityGroups`
    if (seen.has(a) || seen.has(b)) return false;
    seen.add(a);
    seen.add(b);
  }
  return paths.length > 0;
}

/** Draws a tile's revenue-centre markers -- station circle, town dit(s),
 *  or a neutral junction dot -- on top of whatever track was already
 *  stroked. Extracted from `drawTrackPath` by design note #122 so the
 *  new disjoint-path branch and the original fan branch share one
 *  implementation instead of growing a second copy that could drift.
 *
 *  Keyed purely on TERRAIN, never on edge count -- see the notes inside.
 *  `DoubleTown` is handled by `DOUBLE_TOWN_ROUTES` before this is ever
 *  reached, so its branch here is a fallback for a double-town tile with
 *  no explicit artwork entry. */
function drawTileMarkers(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
  entry: TileCatalogEntry,
  edges: readonly number[],
): void {
  //
  // Design note #118: this block used to live INSIDE the 3+-edge branch (for
  // the station circle) and to be gated on `edges.length === 2` (for the
  // dits), which quietly assumed the old invented catalog's geometry. The
  // real 1830 tray catalog breaks both assumptions in ways that matter:
  //
  //   - #57, the Yellow `MajorCityHub` that EVERY plain-city hex on the
  //     board starts from, has exactly TWO live edges (0/3, a straight) --
  //     so under the old placement it drew no station circle at all, the
  //     single most visible tile in the game rendering as bare track.
  //   - #1/#2/#55/#56/#69, the Yellow `DoubleTown`s, have FOUR live edges
  //     each -- so under the old `=== 2` gate they drew no dits, and picked
  //     up the neutral junction dot instead, reading as plain track.
  //
  // Hoisting the whole thing out and keying it purely on TERRAIN (never on
  // edge count) fixes both and is inherently robust to any future catalog
  // whose geometry differs again.
  if (entry.terrain === "MajorCityHub" || entry.terrain === "BostonHub") {
    // design note #49: Boston/Baltimore's own "B"-labeled single-city hub
    // (`BostonHub`) gets the same single-station treatment as an ordinary
    // MajorCityHub -- the "B" label is a legality restriction, not a
    // different artwork shape.
    drawStationCircle(ctx, center, size);
  } else if (entry.terrain === "SmallTown") {
    // A solid DARK circle (design note #3b / item 8's "Distinct Dark Small
    // Towns"), deliberately not the small white circle this file used
    // previously, so a town/dit reads as visually distinct from a buildable
    // city station hub at a glance.
    drawDitMarker(ctx, center, size);
  } else if (entry.terrain === "DoubleTown") {
    // Standardized onto the SAME `twoNodePositions` diagonal coordinates as
    // G19/OO/every unlaid double-town-designated hex (design notes #57/#58).
    // Index 0/1 map directly onto the two `drawDitMarker` calls below, first
    // slot then second slot, with no re-sorting.
    const [node0, node1] = twoNodePositions(center, size);
    drawDitMarker(ctx, node0, size * 0.85); // index 0: top-right
    drawDitMarker(ctx, node1, size * 0.85); // index 1: bottom-left
  }
  // FIX (design note #128): a branch used to sit here giving any non-city
  // tile with 3+ live edges a small dark dot at hex centre. That dot is why
  // Green and Brown PLAIN track showed phantom towns -- at 0.18 radius in
  // `#555555` it reads as a dit, and the multi-edge plains and junctions
  // (#16, #39-#47, #70) all qualified. A junction is a track crossing, not a
  // revenue centre; real cardboard prints nothing there.
  //
  // Every marker this function draws is now gated on TERRAIN alone -- never
  // on edge count, never on path shape. Only `SmallTown`/`DoubleTown`
  // produce dits, only `MajorCityHub`/`BostonHub` a station circle, and
  // anything else draws no centre marker at all.
}

/* Design note #126 deleted `drawRevenueBadge` from here -- the bespoke
   white disc the picker drew for itself. It clashed with the board's own
   shape-coded `drawValueBadge` art, which was the reported bug. Both
   surfaces now go through `drawValueBadgeAt`, the single extracted
   implementation, so a value is identical in the tray and on the map. */


/* ------------------------------------------------------------------ */
/* Design note #131: HARDCODED ARTWORK INTERCEPT                       */
/* ------------------------------------------------------------------ */

/** Draws `tileId` from its hand-authored `TILE_GRAPHICS_CATALOG` entry and
 *  returns `true`, or returns `false` if this tile has no explicit artwork
 *  and the caller should fall through to its procedural path.
 *
 *  THIS IS THE "ART, NOT MATH" BOUNDARY. Everything below the `return true`
 *  is literal `Path2D` playback of a hand-written `d` string. No control
 *  point is computed here, no offset is derived, `bezierTrackSegment` and
 *  `edgeInwardNormal` are never reached for a catalogued tile. Adding a
 *  tile to `TILE_GRAPHICS_CATALOG` is therefore the whole mechanism for
 *  taking it off procedural generation -- there is no second switch to flip
 *  and no way for the two renderers to disagree about one tile, because
 *  only one of them ever runs.
 *
 *  ORIENTATION is a rigid `ctx.rotate` about the hex centre -- the tile is
 *  turned, exactly as cardboard is turned. `-60 * orientation` degrees
 *  matches `edgeAngleRad`'s own `-60 * i` convention, so base edge `i`
 *  lands on live edge `(i + orientation) % 6`, agreeing with
 *  `rotateConnections` by construction rather than by coincidence.
 *
 *  TRACK IS STROKED BEFORE MARKERS, always, and markers are drawn OUTSIDE
 *  the rotated/scaled transform in plain board pixels. Two reasons, both
 *  load-bearing: a crossing arm (#55/#68's two straights meet at centre)
 *  must never be stroked over a station it passes, and a circle drawn under
 *  `ctx.scale(size, size)` would take its stroke width from the transform
 *  and stop matching every other marker on the board. */
function drawHardcodedTileArtwork(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
  tileId: number,
  orientation: number,
): boolean {
  const paths = tileArtworkPaths(tileId);
  const art = TILE_GRAPHICS_CATALOG[tileId];
  if (!paths || !art) return false;

  const rot = ((orientation % 6) + 6) % 6;

  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.rotate((-60 * rot * Math.PI) / 180);
  ctx.scale(size, size);
  ctx.strokeStyle = "#2b2b2b";
  // The catalog is authored in unit-hex space, so the transform scales the
  // pen too -- divide back out to land on the SAME on-screen stroke width
  // (`max(3, size * 0.12)`) every other track in this file uses.
  ctx.lineWidth = Math.max(3, size * 0.12) / size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const path of paths) {
    ctx.stroke(path);
  }
  ctx.restore();

  // Markers, in board pixels, at their own explicit per-tile coordinates.
  // A two-node tile shrinks its marker exactly as the old `cityGroups`
  // branch did (`size * 0.85`), so a tile moving onto this renderer keeps
  // the marker size players already know.
  const markerSize = art.markers.length > 1 ? size * 0.85 : size;
  const points = tileMarkerPoints(tileId, orientation, center, size);
  art.markers.forEach((marker, index) => {
    const point = points[index];
    if (!point) return;
    if (marker.kind === "town") {
      // A town is a stop, never a station -- it has no slots and can never
      // take a token, so it is always the plain dot.
      drawDitMarker(ctx, point, markerSize);
      return;
    }
    const slots = marker.slots ?? 1;
    if (slots > 1) {
      // Design note #133: the tile's own rotation is folded into the pill
      // axis HERE rather than inside `drawStationPill`, because the marker
      // pass runs in unrotated board pixels -- `-60 * rot` is the same
      // convention `ctx.rotate` used for the track above, so the pill turns
      // with the track it sits on.
      drawStationPill(ctx, point, markerSize, slots, (marker.angle ?? 0) - 60 * rot);
    } else {
      drawStationCircle(ctx, point, markerSize);
    }
  });

  return true;
}

function drawTrackPath(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
  entry: TileCatalogEntry,
  orientation: number,
  /** Design note #124: draw the tile's own revenue disc. Default `true`, so
   *  every isolated rendering of a tile (picker thumbnails, the rotation
   *  preview) carries its value. The main BOARD loop passes `false`: laid
   *  hexes already get a value badge from this file's own long-standing
   *  `drawValueBadge` pass, which is placement-aware and knows about
   *  off-board tiers and per-hex overrides. Drawing both would stamp two
   *  different numbers on the same hex. */
  showRevenue = true,
  /** Design note #132: the chain's own `MapTileEntry.revenue` for this
   *  tile, when the caller has a laid tile to read it from. `undefined` for
   *  a tray thumbnail of a tile that isn't on the board yet, which falls
   *  back to the terrain bucket -- the one place that fallback is still
   *  correct, since there is no chain record to disagree with. */
  revenueOverride?: number,
): void {
  // ==== Design note #131: hardcoded artwork wins, unconditionally. ====
  // FIRST statement in the function, ahead of `rotateConnections`/
  // `liveEdges` and every procedural branch below, so a catalogued tile
  // cannot reach them even by accident. The overlays pass still runs --
  // that is the revenue badge and the "B"/"NY"/"OO" restriction label,
  // neither of which is track art.
  if (drawHardcodedTileArtwork(ctx, center, size, entry.tileId, orientation)) {
    drawTileOverlays(ctx, center, size, entry, showRevenue, revenueOverride);
    return;
  }

  const actualMask = rotateConnections(entry.connections, orientation);
  const edges = liveEdges(actualMask);

  const apothem = size * (Math.sqrt(3) / 2);
  const edgePoint = (edgeIndex: number) => pointOnCircle(center, apothem, edgeAngleRad(edgeIndex));

  ctx.strokeStyle = "#2b2b2b";
  ctx.lineWidth = Math.max(3, size * 0.12);
  ctx.lineCap = "round";

  // Design note #119: the DoubleTown discrete-path branch, checked before
  // everything else because it is the narrowest and most specific case.
  //
  // SCOPE, deliberately: this branch is gated on `terrain === "DoubleTown"`
  // AND on discrete paths actually being available, so it can only ever
  // capture #1/#2/#55/#56/#69. Every other tile -- including the multi-edge
  // city and plain tiles, whose Rust catalog rows DO carry path lists --
  // falls through to exactly the branches it used before, unchanged. That
  // is a scope decision, not an oversight: the existing branches already
  // render those correctly, and routing them through here too would restyle
  // most of the board for no correctness gain.
  //
  // Why these five needed it: each has FOUR live edges paired into TWO
  // independent two-edge routes, one per town, and `connections` is a flat
  // union that cannot say which edge pairs with which. Proof that the mask
  // alone is insufficient rather than merely inconvenient -- #1 and #55
  // share the identical mask `0b01_1011` but pair as {0,4}+{1,3} versus
  // {0,3}+{1,4}; #2 and #56 share `0b00_1111` but pair as {0,3}+{1,2}
  // versus {0,2}+{1,3}. No function of the mask can tell those apart. The
  // old fan-to-centre rendering drew all four of them as the same four-way
  // junction with two dits floated at fixed offsets, which is wrong track
  // topology and wrong dit placement on every one of the five.
  // SUPERSEDED APPROACH (design note #121): a first pass drew these from
  // the catalog's path data through a generalized offset -- each route bent
  // through its own node so the two dits could not collide. That was wrong
  // on the tiles it mattered most for. #55 is two straights crossing in an
  // X, and bending both arms through offset nodes visibly bowed them into
  // something that is not the tile; #56's two gentle curves came out warped
  // enough to be hard to read. The lesson is that "make the markers fit" is
  // not a good enough reason to move the TRACK. There are exactly five of
  // these tiles in all of 1830, so they are now drawn from an explicit
  // per-tile table (`DOUBLE_TOWN_ROUTES`) instead of derived, and the dits
  // move around the geometry rather than the geometry moving around them.
  const doubleTownRoutes =
    entry.terrain === "DoubleTown" ? DOUBLE_TOWN_ROUTES[entry.tileId] : undefined;
  if (doubleTownRoutes) {
    const rot = ((orientation % 6) + 6) % 6;
    // Every route drawn before any dit, so a crossing arm (#55's X crosses
    // at centre by definition) can never be stroked over a town marker.
    const ditPoints = doubleTownRoutes.map((route) => {
      const edgeA = (route.edges[0] + rot) % 6;
      const edgeB = (route.edges[1] + rot) % 6;
      const along = drawDoubleTownRoute(ctx, center, size, apothem, edgeA, edgeB);
      // Design note #123: each town sits at its own explicit `ditAt`, out
      // along its arm and clear of the crossing -- never at `t = 0.5`,
      // which is precisely where the other track passes.
      return along(route.ditAt);
    });
    for (const point of ditPoints) {
      drawDitMarker(ctx, point, size * 0.85);
    }
    drawTileOverlays(ctx, center, size, entry, showRevenue, revenueOverride);
    return;
  }

  // Design note #122: every OTHER tile whose catalog paths are disjoint --
  // #16/#18/#19/#20's crossing green plains, and the single-track tiles
  // (#3/#4/#7/#8/#9/#57/#58) -- is now drawn from those declared paths too,
  // with the same canonical straight/gentle/sharp primitives the
  // double-towns use. This is the "art, not math" rule applied to the whole
  // catalog: track shape comes from sourced path data, never from a guess
  // about what a flat bitmask might have meant. Junction and city tiles
  // deliberately do NOT come through here -- see `pathsAreDisjoint`.
  // REGRESSION FIX (design note #130): the `!entry.cityGroups` guard is
  // load-bearing and its absence was the reported "city markers completely
  // missing" bug, introduced by design note #122's own ordering.
  //
  // Every two-city tile has DISJOINT paths by definition -- that is what
  // makes it two cities rather than one hub. #54/#62 are `[[0,1],[2,3]]`,
  // #59 two spurs, #64-#68 two pairs. So this branch, sitting above the
  // `cityGroups` branch, swallowed all eight of them: it drew their track
  // correctly and then handed off to `drawTileMarkers`, which keys on
  // terrain and has no case for `NewYorkHub`/`DoubleCityHub` -- because
  // those were always meant to have drawn their own pair of station circles
  // in the `cityGroups` branch that now never ran. Result: correct track,
  // no cities at all.
  //
  // Guarding here rather than reordering the branches keeps the diff honest
  // about which one is the special case: `cityGroups` tiles have bespoke
  // two-node artwork and must claim themselves first; this branch is the
  // general disjoint-path renderer for everything else.
  if (!entry.cityGroups && entry.paths && pathsAreDisjoint(entry.paths)) {
    const rot = ((orientation % 6) + 6) % 6;
    for (const [baseA, baseB] of entry.paths) {
      drawDoubleTownRoute(ctx, center, size, apothem, (baseA + rot) % 6, (baseB + rot) % 6);
    }
    drawTileMarkers(ctx, center, size, entry, edges);
    drawTileOverlays(ctx, center, size, entry, showRevenue, revenueOverride);
    return;
  }

  // Design note #118: `cityGroups` is checked FIRST now, ahead of the
  // 2-live-edge shortcut below. Previously the shortcut won, which was
  // harmless while the only two-city tiles in the catalog had 4+ live edges
  // -- but the real 1830 tray catalog includes #59 ("OO" Green), whose two
  // cities are a pair of DISCONNECTED one-edge stubs on edges 0 and 2.
  // That's exactly 2 live edges, so the old ordering would have drawn it as
  // a single continuous curve joining the two edges through one shared
  // centre node: visually a through-route, and factually the opposite of
  // what the tile is (`hexmap::terrain_base_value` prices `DoubleCityHub` at
  // $40 -- one station per visit -- precisely BECAUSE those two stations
  // don't connect intra-hex).
  if (entry.cityGroups) {
    // Design note #52: a genuine two-city tile (New York, every OO
    // variant) -- draw each city's own paired-edge curve into ITS OWN
    // station point, NOT one shared fan-to-center hub. The old code below
    // (still used for single-city tiles) fanned every live edge into
    // `center`, which was fine for a `MajorCityHub`/`BostonHub` tile (a
    // single real city) but wrong for these: the real tile has two
    // physically independent city nodes, and treating all of a NY/OO
    // tile's edges as radiating from ONE point drew phantom track past
    // wherever the OTHER city's own edges actually terminate, and is what
    // let a corrected (sparse) bitmask still look like a 6-spoke wildcard
    // fanning from hex center. `twoCityStationPoints` gives the exact same
    // two points the station-circle block below draws its circles at, so
    // track and circles can't drift apart.
    //
    // BUG FIX (design note #118): `cityGroups` is expressed in BASE
    // (pre-rotation) edge numbers, exactly like `entry.connections`, but
    // `edges` above is the POST-rotation live set. The old code intersected
    // the two directly, so at any `orientation !== 0` the intersection came
    // back empty or partial and a rotated NY/OO tile silently drew little or
    // none of its own track. `rotateConnections` shifts base edge `e` to
    // `(e + orientation) % 6` (bit `e` left-shifted by `orientation`), so
    // the same transform is applied here before intersecting.
    const rot = ((orientation % 6) + 6) % 6;
    const stationPoints = twoCityStationPoints(entry.terrain, center, size);
    entry.cityGroups.forEach((groupEdges, cityIndex) => {
      const liveGroupEdges = groupEdges
        .map((edge) => (edge + rot) % 6)
        .filter((edge) => edges.includes(edge))
        .sort((a, b) => a - b);
      if (liveGroupEdges.length === 0) return;
      const stationPoint = stationPoints[cityIndex] ?? center;
      if (liveGroupEdges.length === 1) {
        const point = edgePoint(liveGroupEdges[0]);
        bezierTrackSegment(ctx, point, stationPoint, size, edgeInwardNormal(liveGroupEdges[0]), null);
      } else if (liveGroupEdges.length === 2) {
        const [a, b] = liveGroupEdges;
        const start = edgePoint(a);
        const end = edgePoint(b);
        const isOpposite = Math.abs(b - a) === 3;
        if (isOpposite) {
          ctx.beginPath();
          ctx.moveTo(start.x, start.y);
          ctx.lineTo(end.x, end.y);
          ctx.stroke();
        } else {
          bezierTrackSegment(ctx, start, stationPoint, size, edgeInwardNormal(a), null);
          bezierTrackSegment(ctx, stationPoint, end, size, null, edgeInwardNormal(b));
        }
      } else {
        for (const edge of liveGroupEdges) {
          const point = edgePoint(edge);
          bezierTrackSegment(ctx, point, stationPoint, size, edgeInwardNormal(edge), null);
        }
      }
    });

    // Both two-node terrains draw the identical pair of station circles --
    // see `twoCityStationPoints`/design note #56 for why `NewYorkHub` was
    // merged onto `DoubleCityHub`'s geometry rather than keeping its own.
    drawStationCircle(ctx, stationPoints[0], size * 0.85);
    drawStationCircle(ctx, stationPoints[1], size * 0.85);
    // Design note #124: two-node hubs return through the shared tail below,
    // so their badge is drawn there like every other tile's.
  } else if (edges.length === 2) {
    const [a, b] = edges;
    const start = edgePoint(a);
    const end = edgePoint(b);
    // `liveEdges` returns edges in ascending order (a < b), so a true
    // opposite pair -- 0&3, 1&4, 2&5 -- is exactly the b - a === 3 case;
    // no modular-distance math is needed given that ordering.
    const isOpposite = b - a === 3;

    // BUG FIX (Revenue Center Connectivity pass -- see `drawPrintedTrack`'s
    // identical fix for the full derivation of why `arcTo` never actually
    // touches `center`). Design note #118 update: the real tray catalog makes
    // this branch far busier than the old one did -- it now carries every
    // single-town tile (#3/#4/#58), every plain curve and straight
    // (#7/#8/#9), AND #57, the yellow city tile that starts every plain-city
    // hex on the board -- so the hardening below is load-bearing now rather
    // than merely proactive.
    if (isOpposite) {
      // A true through-route: edges directly across the tile from each
      // other -- a straight track, per this feature's explicit request
      // to use `ctx.lineTo` for this case.
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
    } else {
      // Rail Map Overhaul (design note #42): two cubic-Bezier halves via
      // `bezierTrackSegment`, each perpendicular-entering its own edge
      // (`edgeInwardNormal(a)`/`edgeInwardNormal(b)`) and easing through the
      // shared station node at `center` -- replaces the previous
      // `quadraticCurveTo`-based `curveHalf` closure.
      bezierTrackSegment(ctx, start, center, size, edgeInwardNormal(a), null);
      bezierTrackSegment(ctx, center, end, size, null, edgeInwardNormal(b));
    }
  } else if (edges.length > 0) {
    // Three or more live edges, single city (a `MajorCityHub`/`BostonHub`
    // tile) or an ordinary multi-spur junction: the bitmask alone doesn't
    // say which pairs route together (see design note #3), so draw a spoke
    // from each live edge into a shared center "station" node instead.
    // Rail Map Overhaul (design note #42): each spoke is now a
    // perpendicular-entering Bezier curve (`bezierTrackSegment`), matching
    // `drawPrintedTrack`'s own already-curved 3+-edge treatment, instead of
    // the previous straight `lineTo` spoke.
    //
    // Design note #118: this is also the deliberate GENERIC-ARTWORK fallback
    // for the real tray catalog's multi-edge DOUBLE-TOWN tiles (#1, #2,
    // #55, #56, #69 -- four live edges each, two towns each). Real 1830
    // pairs those four edges into two specific two-edge town routes, but
    // `hexmap::TILE_CATALOG` only publishes the flat union bitmask, and this
    // file's standing discipline (design note #3) is to render what the data
    // actually says rather than invent a pairing it doesn't. So each edge
    // fans to centre and the two dit markers are drawn at the canonical
    // two-node positions below: correct terrain, correct live edges, correct
    // stop count, approximate intra-tile routing. Upgrade path if the
    // backend ever publishes per-node edge groups: give those five entries
    // `cityGroups` and they move to the first branch with no other change.
    for (const edge of edges) {
      const point = edgePoint(edge);
      bezierTrackSegment(ctx, point, center, size, edgeInwardNormal(edge), null);
    }
  }

  drawTileMarkers(ctx, center, size, entry, edges);
  drawTileOverlays(ctx, center, size, entry, showRevenue, revenueOverride);
}

/* ------------------------------------------------------------------ */
/* Traced route overlay -- design note #137 (F-1)                       */
/* ------------------------------------------------------------------ */

/** Draws every traced train route as a wide translucent ribbon following the
 *  real track geometry.
 *
 *  GEOMETRY, and why it is not just a polyline between hex centres: each hop
 *  is drawn as two `bezierTrackSegment` halves -- centre to the shared edge
 *  midpoint, then that midpoint to the next hex's centre -- the exact same
 *  primitive, with the exact same perpendicular-entry normals, that
 *  `drawTrackPath` uses for real track. A straight centre-to-centre line
 *  would visibly cut the corner on every curve and drift off the rails it is
 *  meant to be highlighting.
 *
 *  STROKE. Wide (`size * 0.30`, roughly 2.5x a track spline's own
 *  `size * 0.12`), round-capped and round-joined, at 55% alpha. Translucent
 *  rather than opaque so the track beneath stays legible through it -- an
 *  opaque ribbon would hide exactly the thing it is pointing at -- and so two
 *  routes sharing a hex show their overlap instead of the later one simply
 *  winning.
 *
 *  NON-ADJACENT PAIRS ARE SKIPPED, not drawn. A caller can hand over a
 *  partially-built route whose ends are not yet connected (the manual route
 *  builder does exactly that, as the player clicks hexes). Drawing a straight
 *  line across the board between two distant hexes would assert a connection
 *  that does not exist; skipping the segment shows the pieces that ARE real
 *  and leaves the gap visible, which is the honest rendering of an incomplete
 *  route.
 *
 *  Restores every context field it touches, so the passes after it are
 *  unaffected. */
function drawRouteOverlays(
  ctx: CanvasRenderingContext2D,
  size: number,
  overlays: readonly RouteOverlay[],
): void {
  if (overlays.length === 0) return;

  const apothem = size * (Math.sqrt(3) / 2);

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(6, size * 0.3);
  ctx.globalAlpha = 0.55;

  for (const overlay of overlays) {
    if (overlay.hexes.length < 2) continue;
    ctx.strokeStyle = overlay.color;

    for (let index = 0; index < overlay.hexes.length - 1; index += 1) {
      const [q, r] = overlay.hexes[index];
      const [nextQ, nextR] = overlay.hexes[index + 1];

      // Which edge of the current hex faces the next one. `undefined` means
      // they are not neighbours -- see the doc comment on why that is skipped
      // rather than bridged.
      const exitEdge = HEX_NEIGHBOR_OFFSETS.findIndex(
        ([dq, dr]) => q + dq === nextQ && r + dr === nextR,
      );
      if (exitEdge < 0) continue;

      const center = axialToPixel(q, r, size);
      const nextCenter = axialToPixel(nextQ, nextR, size);
      const crossing = pointOnCircle(center, apothem, edgeAngleRad(exitEdge));
      const arrivalEdge = (exitEdge + 3) % 6;

      // Same two-half construction, same normals, as a real track spline --
      // so the ribbon lies along the rails through curves instead of cutting
      // across them.
      bezierTrackSegment(ctx, center, crossing, size, null, edgeInwardNormal(exitEdge));
      bezierTrackSegment(ctx, crossing, nextCenter, size, null, edgeInwardNormal(arrivalEdge));
    }
  }

  ctx.restore();
}

/** GENERIC PLACEHOLDER ARTWORK for a `tile_id` that isn't in this file's
 *  `TILE_CATALOG` mirror (design note #118, requirement 3).
 *
 *  Both render paths that decode a laid tile -- the main board loop in
 *  `draw()` and `TilePreviewThumbnail` -- previously handled an unknown id
 *  by printing a bare red `#N?` string on a flat grey hex. That was safe
 *  (it never threw), but it degraded to something the player can't act on:
 *  the tile-picker carousel in `TileSelectionPopup.tsx` offers whatever
 *  `GetLegalTilePlacements` returns, verbatim and unfiltered (that
 *  component's own design note #4), so an id this mirror hasn't caught up
 *  to yet is still a fully legal, clickable, submittable choice -- just an
 *  unrecognisable one.
 *
 *  This draws a neutral but READABLE stand-in instead: a dashed neutral
 *  outline marking it as provisional, plus the tile number. It deliberately
 *  does NOT guess at track geometry -- there is no bitmask to decode, and a
 *  fabricated path would be worse than an honest blank, since the player
 *  would have no way to tell it apart from real artwork.
 *
 *  Callers must have already filled/stroked the hex body. Never throws;
 *  takes no catalog lookup. */
function drawUnknownTilePlaceholder(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
  tileId: number,
): void {
  ctx.save();

  ctx.beginPath();
  ctx.arc(center.x, center.y, size * 0.46, 0, Math.PI * 2);
  ctx.setLineDash([size * 0.16, size * 0.12]);
  ctx.strokeStyle = "#8a8a8a";
  ctx.lineWidth = Math.max(1.5, size * 0.06);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = "#4a4a4a";
  ctx.font = `${Math.max(9, Math.round(size * 0.34))}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`#${tileId}`, center.x, center.y);

  ctx.restore();
}

/** A large 1830-style station circle: white fill, dark outline -- used for
 *  `MajorCityHub` laid tiles and every landmark's pre-printed station (see
 *  design notes #3b/#6b). */
function drawStationCircle(
  ctx: CanvasRenderingContext2D,
  point: { x: number; y: number },
  size: number,
): void {
  ctx.beginPath();
  ctx.arc(point.x, point.y, size * 0.22, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.strokeStyle = "#2b2b2b";
  ctx.lineWidth = Math.max(2, size * 0.06);
  ctx.stroke();
}

/** A MULTI-SLOT city station -- design note #133.
 *
 *  Real 18xx cardboard draws a city that can hold N tokens as an elongated
 *  oval ("pill"), N circles wide, not as a bigger circle. That shape is
 *  load-bearing information: it is the only thing on the tile that tells a
 *  player a second company can still build into this city. A 2-slot city
 *  rendered as a plain circle -- which is what every city on this board did
 *  before this pass -- reads as "full", and misleads the player about a
 *  decision they are actively making.
 *
 *  Geometry is two half-circles of the SAME `size * 0.22` radius
 *  `drawStationCircle` uses, joined by straight sides. Consecutive
 *  `ctx.arc` calls inside one path auto-connect with an implicit `lineTo`,
 *  so the sides come for free and the outline is a single closed path --
 *  which matters, because it means one `fill()` and one `stroke()` with no
 *  seam where the two ends meet.
 *
 *  SPACING: centre-to-centre `1.6 * r`, not the `2 * r` that would place two
 *  exactly-tangent circles. Real cardboard overlaps its slot circles
 *  slightly, and at a full `2 * r` the pill on #63 (six radial spokes)
 *  grows long enough to reach its own track arms.
 *
 *  `angleDeg` is the long axis in BOARD space -- the caller has already
 *  folded in the tile's orientation. Markers are drawn outside the
 *  artwork's rotated/scaled transform (see `drawHardcodedTileArtwork`), so
 *  without this a rotated tile would keep a stubbornly horizontal pill
 *  sitting across its own track. */
function drawStationPill(
  ctx: CanvasRenderingContext2D,
  point: { x: number; y: number },
  size: number,
  slots: number,
  angleDeg: number,
): void {
  const radius = size * 0.22;
  const spacing = PILL_SLOT_SPACING * radius;
  const span = spacing * (slots - 1);

  ctx.save();
  ctx.translate(point.x, point.y);
  ctx.rotate((angleDeg * Math.PI) / 180);

  // ---- 1. The outer capsule. ----
  ctx.beginPath();
  ctx.arc(-span / 2, 0, radius, Math.PI / 2, Math.PI * 1.5);
  ctx.arc(span / 2, 0, radius, Math.PI * 1.5, Math.PI / 2);
  ctx.closePath();

  // Identical fill/stroke to `drawStationCircle` -- a 1-slot and a 2-slot
  // city must read as the same KIND of object, differing only in length.
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.strokeStyle = "#2b2b2b";
  ctx.lineWidth = Math.max(2, size * 0.06);
  ctx.stroke();

  // ---- 2. The slot rings. ----
  // One thin circle per slot, INSIDE the capsule, at the exact centres
  // `tileCitySlotPoints` will place tokens on. This is what makes the pill
  // countable: the outline alone says "this city is bigger", the rings say
  // "it holds exactly two". On real cardboard these are the printed circles
  // the wooden tokens drop into.
  //
  // Drawn at roughly HALF the capsule's own stroke weight and never filled,
  // so they read as an internal division of one station rather than as two
  // separate stations that happen to touch -- the distinction matters most
  // on #62, where two genuinely separate 2-slot cities sit on one tile and
  // must not be confusable with one 4-slot city.
  ctx.lineWidth = Math.max(1, size * 0.03);
  for (let slot = 0; slot < slots; slot += 1) {
    const offset = -span / 2 + spacing * slot;
    ctx.beginPath();
    ctx.arc(offset, 0, radius * 0.86, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();
}

/** A small 1830-style town/dit stop marker (design note #59: Lightweight
 *  Solid Black Dot Primitive; radius tuned up by design notes #60 then
 *  #61): a plain solid black filled dot, NO stroke/outline/border and NO
 *  station-container styling of any kind -- a small town sits directly on
 *  or along the track spline as a simple mark, never a buildable city
 *  station hub. Radius `size * 0.14` (design note #61: a second
 *  visual-feedback pass, still too small at #60's `size * 0.112` -- settled
 *  on the same `0.14` MAGNITUDE `drawDitMarker` used before #59, just
 *  without that version's `#141414` fill or `#d8d8d8` ring stroke; ~64% of
 *  `drawStationCircle`'s own `size * 0.22` white city-circle radius, still
 *  visibly smaller than a city station so towns stay distinct at a
 *  glance). Positioning math is UNCHANGED (every call site still passes
 *  the exact same point/size arguments it always has -- see design notes
 *  #54/#55/#58 for that layout); this remains a primitive-styling-only
 *  change, used everywhere a town/dit marker is drawn in this file:
 *  `drawTrackPath`'s laid SmallTown/DoubleTown tiles, `drawPrintedTrack`'s
 *  pre-printed gray-hex towns, and the blank Town/Double-Town-designated
 *  hexes' own marker pass in `draw()`. */
function drawDitMarker(
  ctx: CanvasRenderingContext2D,
  point: { x: number; y: number },
  size: number,
): void {
  ctx.beginPath();
  ctx.arc(point.x, point.y, size * 0.14, 0, Math.PI * 2);
  ctx.fillStyle = "#000000";
  ctx.fill();
}

/** Maps each value-badge-bearing terrain to its badge SHAPE (design note
 *  #62: Shape-Based Revenue Badge Iconography) -- REPLACES the old
 *  `VALUE_BADGE_COLOR` color-coded palette (SmallTown/DoubleTown amber vs.
 *  MajorCityHub/DoubleCityHub crimson). Every revenue badge on the board
 *  uses the SAME solid white fill/dark-navy stroke (see `drawBadgeShape`).
 *
 *  ALL-SQUARE, design note #65: town badges were originally diamonds (the
 *  town-vs-city distinction color used to carry, moved to shape); reported
 *  the diamond's inherent taper -- `badgeRadiusForLabel`'s own doc comment
 *  derives why a diamond needs `halfWidth + halfHeight` of radius just to
 *  clear a text corner, structurally larger than the square's
 *  `max(halfWidth, halfHeight)` -- was taking up too much room. Every
 *  terrain now maps to `"square"`; the board's shape-based iconography
 *  simplifies to: white circles = city stations, small black dots = towns,
 *  white squares = every revenue badge (city, town, and off-board alike).
 *  `"diamond"` stays a valid `drawBadgeShape`/`badgeRadiusForLabel` option
 *  (dead code, not deleted) in case a future pass wants shape-coding back. */
const VALUE_BADGE_SHAPE: Readonly<
  Record<"SmallTown" | "DoubleTown" | "MajorCityHub" | "DoubleCityHub", "square" | "diamond">
> = {
  SmallTown: "square",
  DoubleTown: "square",
  MajorCityHub: "square",
  DoubleCityHub: "square",
};

/** Draws a revenue-badge shape (design note #62): a solid white
 *  (`#FFFFFF`) fill with a `#1E293B` dark-navy stroke, `lineWidth = 1.5` --
 *  the literal, board-wide-uniform styling every revenue badge uses now,
 *  replacing the old per-terrain color-coded circle fills. `"square"` for
 *  city hub and off-board revenue, `"diamond"` (a square rotated 45
 *  degrees, same corner-to-center reach as a circle of the same `radius`,
 *  so it fits the exact same footprint the old circle badge did) for town
 *  revenue. The square's half-side is `radius * Math.SQRT1_2` -- sized so
 *  its OWN farthest corner sits at exactly `radius` from center, the same
 *  maximum reach as the circle it replaces and the diamond drawn alongside
 *  it, so none of `drawValueBadge`'s own corner-placement/bleed-safety
 *  math (its own doc comment's "farthest reach stays safely inside the hex
 *  boundary" analysis) needs to change for the new shapes to stay just as
 *  safe as the circle was. */
function drawBadgeShape(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  radius: number,
  shape: "square" | "diamond",
): void {
  ctx.beginPath();
  if (shape === "square") {
    const half = radius * Math.SQRT1_2;
    ctx.rect(center.x - half, center.y - half, half * 2, half * 2);
  } else {
    ctx.moveTo(center.x, center.y - radius);
    ctx.lineTo(center.x + radius, center.y);
    ctx.lineTo(center.x, center.y + radius);
    ctx.lineTo(center.x - radius, center.y);
    ctx.closePath();
  }
  ctx.fillStyle = "#FFFFFF";
  ctx.fill();
  ctx.strokeStyle = "#1E293B";
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

/** Computes the SMALLEST `drawBadgeShape` radius that fully contains
 *  `label` (already measured via `ctx.measureText` under the caller's own
 *  bold font) with `paddingX`/`paddingY` clearance on every side, for the
 *  given `shape` -- design note #63 (Text-Driven Badge Sizing): previously
 *  `drawValueBadge` fixed the badge's radius first and shrank the font
 *  down (as low as 5px) to whatever fit inside it, which clipped/crowded
 *  longer values; this inverts that relationship, sizing the badge AROUND
 *  a fixed, always-legible bold font instead, the same "measure text, size
 *  the box around it" approach `drawLabelWithBackground` already uses
 *  elsewhere in this file for nameplate shield boxes.
 *
 *  For `"square"`: a square of half-side `h` needs `h >= textWidth/2 +
 *  paddingX` AND `h >= textHeight/2 + paddingY` (its sides are axis-
 *  aligned, so width and height clearance are independent) -- solved for
 *  the `radius` `drawBadgeShape` itself expects (`half = radius *
 *  Math.SQRT1_2`, see that function's own doc comment) by dividing back
 *  through `Math.SQRT1_2`.
 *
 *  For `"diamond"`: a diamond of radius `r` (vertices at `(±r, 0)`/`(0,
 *  ±r)`) has boundary `|x| + |y| = r`, so the widest the diamond gets AT
 *  the text's own vertical extent (`y = textHeight / 2` from center) is
 *  `|x| = r - textHeight / 2` -- solved for `r` so that half-width still
 *  clears `textWidth / 2 + paddingX` at that same height:
 *  `r = textWidth / 2 + paddingX + textHeight / 2 + paddingY`. */
function badgeRadiusForLabel(
  metrics: TextMetrics,
  fontSizePx: number,
  shape: "square" | "diamond",
  paddingX: number,
  paddingY: number,
  minRadius: number,
): number {
  const textWidth = metrics.width;
  const ascent = metrics.actualBoundingBoxAscent ?? fontSizePx * 0.75;
  const descent = metrics.actualBoundingBoxDescent ?? fontSizePx * 0.25;
  const textHeight = ascent + descent;
  const neededRadius =
    shape === "square"
      ? Math.max(textWidth / 2 + paddingX, textHeight / 2 + paddingY) / Math.SQRT1_2
      : textWidth / 2 + paddingX + (textHeight / 2 + paddingY);
  return Math.max(minRadius, neededRadius);
}

/** Design note #70 (13-Slot Perimeter Anchor System): the four CORNER slots
 *  `drawValueBadge` ever places a badge at, in PREFERENCE ORDER, expressed
 *  as slot numbers in the shared `hexSlotPoint`/`hexSlotDirection` numbering
 *  (7-12 = corner vertices; see that system's own doc comment). SUPERSEDES
 *  the old file-local `BADGE_CORNERS` array (dx/dy + bespoke `guardEdges`
 *  pairs) -- same four corners, same preference order (both lower corners
 *  first, since every name-label pass in this file draws in the hex's UPPER
 *  area, so neither lower corner ever collides with a name; the two upper
 *  corners as a last resort), but now resolved through the shared
 *  `hexBlockedSlots`/`pickHexSlot` engine instead of a private tiered
 *  search, so this badge and every other label/nameplate/badge in the file
 *  agree on the same slot geometry and the same live/dead-edge blocking
 *  rules. Slot 11 = Lower-Left, 9 = Lower-Right, 12 = Upper-Left,
 *  8 = Upper-Right -- see `drawValueBadge`'s own doc comment for the full
 *  tier ordering this preference list feeds into. */
// Design note #76: appends the two FAR-side edge slots (6/NW, 5/W) as an
// explicit early fallback, ahead of `extendSlotPreference`'s purely neutral
// ascending tail -- reported (G19): even after cross-pass claiming (#72)
// gave every element a mathematically distinct slot, the revenue badge's
// own four corner preferences were all blocked/claimed on a hex as crowded
// as G19, so it fell all the way to the neutral fallback's ascending order,
// which handed back slot 2 (0 degrees) -- angularly RIGHT NEXT TO the
// terrain icon (slot 3, 60 degrees) and terrain-cost label (slot 9, 30
// degrees) it was trying to avoid. Distinct slots, but not distinct enough
// for four real UI elements' own visual footprint at that radius. 6 and 5
// sit on the OPPOSITE side of the hex from that icon/cost cluster, so a
// badge forced past its own corners lands somewhere genuinely clear instead
// of merely technically-unclaimed.
const BADGE_SLOT_PREFERENCE: readonly number[] = [11, 9, 12, 8, 6, 5, 2, 3];

/** Draws one small, crisp city/town value badge (design note #26/item 5,
 *  constrained by item 7 of the structural calibration pass; ADAPTIVE
 *  PLACEMENT follow-up below, generalized by design note #39; shape/color
 *  REPLACED by design note #62) -- `terrainBaseValue`'s flat $ value for
 *  `terrain`, in a solid white, dark-navy-stroked badge shape-coded via
 *  `VALUE_BADGE_SHAPE` (square for city hubs, diamond for towns -- see
 *  `drawBadgeShape`'s own doc comment). Offset toward whichever of the
 *  hex's four corners (never hex center, where the track/station marker
 *  already sits) is actually free of both printed track and a name label,
 *  so the badge never collides with either.
 *
 *  ADAPTIVE PLACEMENT (reported: the previous single fixed upper-right
 *  corner routinely collided with this file's own city-name labels, which
 *  moved into that same upper area in an earlier pass -- worst on G19/New
 *  York, where the upper-right corner is ALSO exactly where its real
 *  printed NE track stub runs, stacking the badge on top of the track, the
 *  station circle, AND the name all at once). Tries each of `BADGE_CORNERS`
 *  in preference order across four tiers, most-preferred first:
 *
 *   1. No `guardEdges` overlap with `liveEdges` AT ALL, AND at least one
 *      `guardEdges` entry is a permanently dead edge (`deadEdgesAt(q, r)`,
 *      design note #39) -- both no current track collision risk AND a
 *      structural guarantee no FUTURE track can ever appear there either.
 *   2. At least one `guardEdges` entry is dead, even if the other currently
 *      has live track -- reported: I15/Baltimore's real edge-0/edge-4
 *      through-route blocks BOTH lower corners under tier 3 below (edge 4
 *      guards lower-left, edge 0 guards lower-right), forcing the badge
 *      into upper-left, which collides with Baltimore's own name label --
 *      even though edge 0's neighbor (I17) is a real hex, edge 5 (lower-
 *      right's OTHER guard) points off the board's actual footprint
 *      entirely and can NEVER carry track from either side, so lower-right
 *      is preferred here over sitting in the name-colliding upper area.
 *   3. No `guardEdges` overlap with `liveEdges` -- this hex's own actual
 *      printed/laid track, in whichever edge-index form the caller already
 *      has on hand (`GRAY_HEXES`' `.edges`, `LANDMARK_TRACKS`' segments
 *      flattened, or a laid tile's `connections` mask run through
 *      `liveEdges()`/`rotateConnections()`). The original (pre-#39)
 *      adaptive-placement tier, unchanged for every hex with no dead edge
 *      at all (the overwhelming majority of the board, where tiers 1-2
 *      never match anything and this is reached first).
 *   4. Nothing above matched (every corner collides with live track, none
 *      of it against a dead edge) -- falls back to the first candidate
 *      (lower-left) anyway, the closest a four-corner model can get without
 *      a full per-hex custom-angle system, and still strictly no worse than
 *      the old always-upper-right placement.
 *
 *  `liveEdges` and `deadEdgesAt(q, r)` both empty -- an OO hex, a blank
 *  city/town designation, or any other interior hex with no real track to
 *  dodge and no board-edge boundary nearby -- skips straight to tier 3,
 *  i.e. exactly the plain "move it to the bottom-left" fallback for every
 *  hex with nothing to actively avoid or exploit.
 *
 *  Item 7 CONSTRAINT FIX (still governs the offset magnitude, unchanged by
 *  the corner becoming adaptive): the previous offset (`0.52`/`0.52`,
 *  radius `0.22`) placed the badge's farthest edge at `~0.955 * size` from
 *  hex center along its 45-degree diagonal -- but a pointy-top hex's own
 *  boundary at that diagonal (`cornerAngleRad`'s corners sit at 30/90/etc,
 *  so 45 degrees falls mid-edge, apothem-adjacent) is only `~0.897 * size`
 *  out, meaning the badge visibly bled past the hex's own border into the
 *  neighboring hex. The `0.44 * size` magnitude below is UNCHANGED and
 *  still keeps the badge's nearest edge clear of the `size * 0.22`-radius
 *  station circle at hex center, at every candidate slot alike.
 *
 *  Design note #70 (13-Slot Perimeter Anchor System): the DIRECTION that
 *  magnitude is applied along is no longer the old fixed 45-degree diagonal
 *  (`{dx: ±1, dy: ±1}`, unit-normalized implicitly by being applied to both
 *  axes) -- it's now `hexSlotDirection(slot)`, the true unit vector toward
 *  whichever real corner vertex (`cornerAngleRad`) the chosen slot names
 *  (30/150/210/330 degrees for the four badge corners, not 45/135/225/315).
 *  Since `0.44 * size` sits well inside even the nearest hex boundary
 *  point (the `~0.866 * size` apothem), this is safe at every one of the
 *  four true corner angles, not just the old diagonal approximation --
 *  see the module-level 13-Slot Perimeter Anchor System doc comment for
 *  the full slot numbering this and every other label/badge pass now
 *  shares.
 *
 *  HONEST CAVEAT (design note #63: Text-Driven Badge Sizing): the
 *  `~0.80 * size` farthest-reach bound above described the OLD fixed-
 *  radius badge; the radius is now sized around its own measured label
 *  text (`badgeRadiusForLabel`) instead of a flat constant, so a longer
 *  printed value (more digits) now produces a proportionally larger badge
 *  than a shorter one at the same hex. Every real value on this board
 *  today (`terrainBaseValue`'s flat $10/$20/$40 and every
 *  `HEX_START_VALUE_OVERRIDE` figure) is at most 2-3 digits and still
 *  comfortably clears this same boundary margin in practice -- flagged
 *  here rather than silently assumed, since it's no longer a fixed,
 *  independently-provable bound the way the old constant-radius one was. */
function drawValueBadge(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  // Design note #39: this hex's own axial coordinates, needed to look up
  // `deadEdgesAt(q, r)` -- `center` alone (a pixel position) can't recover
  // these, and every existing call site already has them on hand (they're
  // how `center` itself was computed via `axialToPixel`).
  q: number,
  r: number,
  terrain: "SmallTown" | "DoubleTown" | "MajorCityHub" | "DoubleCityHub",
  size: number,
  // Design note #35/items 2-3: an explicit $ figure that overrides
  // `terrainBaseValue(terrain)`'s flat default, for the specific named hexes
  // `HEX_START_VALUE_OVERRIDE` gives a real, sourced, non-$20/$10 value --
  // `terrain` is still passed and still drives `VALUE_BADGE_SHAPE` (design
  // note #62), so an overridden badge keeps the same square/diamond shape
  // as every other badge of its terrain, just with a different printed
  // number. Omit (or pass a hex's own $0 override -- callers check for that
  // BEFORE calling this
  // function and skip the call entirely instead, see design note #35) to
  // keep the previous flat-by-terrain behavior unchanged.
  valueOverride?: number,
  // ADAPTIVE PLACEMENT: this hex's own live track edges, if the caller has
  // them on hand -- see `BADGE_CORNERS`'s doc comment. Omitted/empty means
  // "no track to dodge," which (absent a dead edge too) resolves to the
  // lower-left corner.
  liveEdges: readonly number[] = [],
  // Design note #72: shared cross-pass claiming ledger (see
  // `claimHexSlot`'s own doc comment) -- this is the LAST of the four
  // slot-picking passes to run each render (icon, restriction badge,
  // terrain-cost label, then this one), so on a crowded hex it's the one
  // most likely to need its fallback tail; without this, it independently
  // picked the exact same corner the terrain-cost label had already
  // claimed on New York/G19 (the bug this whole design note fixes).
  claimedHexSlots: Map<string, Set<number>> = new Map(),
): void {
  const value = valueOverride ?? terrainBaseValue(terrain);
  // Design note #70: same four-tier dead/live-edge preference as before,
  // now resolved via the shared 13-slot engine -- `slotsBlockedByEdges`
  // marks a corner slot BLOCKED whenever either of its two guard edges
  // (the same pairing `BADGE_CORNERS`' `guardEdges` used to hand-encode,
  // now derived generically by `cornerSlotGuardEdges`) carries live track,
  // and `pickHexSlot` runs the identical tier search: prefer a slot that's
  // both unblocked AND dead-edge-adjacent, then any dead-edge-adjacent slot
  // even if blocked, then any unblocked slot, then the first preference.
  // Design note #72: now via `claimHexSlot`, so this badge also avoids
  // whatever the icon/restriction/cost-label passes already claimed on
  // this same hex this render.
  const blocked = slotsBlockedByEdges(liveEdges, false);
  const dead = slotsBlockedByEdges(deadEdgesAt(q, r), false);
  const revenueForce = HEX_SLOT_FORCE[`${q},${r}`]?.revenue;
  const revenueOverride = resolveSlotOverride(q, r, "revenue");
  const revenuePreference = withSlotReserve(q, r, "revenue", BADGE_SLOT_PREFERENCE);
  const slot =
    revenueForce !== undefined
      ? claimHexSlotForced(claimedHexSlots, q, r, revenueForce)
      : claimHexSlotPreferring(claimedHexSlots, q, r, revenueOverride, revenuePreference, blocked, dead);
  const direction = hexSlotDirection(slot);
  // Design note #109: magnitude INCREASED again, to `0.65` (was `0.55` per
  // #108, `0.38` per #107, `0.44` originally), direct follow-up request.
  // HONEST MARGIN CHECK, same two boundary shapes #108 checked: at a
  // CORNER slot (boundary = full `size`) there's still `size * 0.19` of
  // clearance past this file's own documented worst-case badge radius
  // (`badgeRadiusForLabel` keeps even a 3-digit value under `size * 0.16`,
  // reaching `size * 0.81`). At an EDGE slot, though (boundary = `apothem`
  // = `size * 0.866`), that same worst-case reach leaves only
  // `size * 0.056` of clearance -- noticeably tighter than #108's `0.156`,
  // and a badge printing a genuinely wide value at that exact slot could
  // start to visually crowd (though not yet mathematically cross) the hex
  // boundary there. Implemented as requested; flagging this narrowing
  // margin rather than silently accepting it, in case a future request
  // pushes this further still and actually crosses it.
  const REVENUE_BADGE_OFFSET = 0.65;
  const badgeCenter = {
    x: center.x + direction.x * size * REVENUE_BADGE_OFFSET,
    y: center.y + direction.y * size * REVENUE_BADGE_OFFSET,
  };

  // Design note #63: Text-Driven Badge Sizing + Bold Text -- fixed bold
  // font first (no more shrink-to-fit down to a barely-legible 5px), badge
  // shape sized around the MEASURED text afterward via
  // `badgeRadiusForLabel`, so the number always has clear, non-clipped
  // room inside its own badge regardless of how many digits it has.
  // TIGHTENED by design note #64: reported too large/loose after #63 --
  // font dropped 1pt, padding tightened to this file's own established
  // 2px "tight shield box" convention, and the floor dropped to a small
  // flat safety minimum instead of the old fixed-badge-era radius (which
  // was silently dominating over the text-fit calculation for every short
  // 2-digit value, defeating the whole point of sizing to the text).
  // Font dropped ANOTHER 1pt by design note #65 (now -2pt off the original
  // #63 baseline), alongside that same pass's all-square shape switch.
  // Design note #66: `$` prefix DROPPED from the printed label -- the
  // white square shape already unambiguously reads as "revenue value" on
  // its own (per #62's board-wide shape iconography), so the symbol was
  // redundant; dropping it also leaves more of the tightly-fit square for
  // the digits themselves. Font bumped back up 1pt (now -1pt net off the
  // #63 baseline, not -2) alongside this change.
  drawValueBadgeAt(ctx, badgeCenter, size, terrain, value);
}

/** THE revenue badge artwork -- design note #126.
 *
 *  Extracted VERBATIM from `drawValueBadge` so the board and the tile picker
 *  cannot render a value differently. That was the whole bug: the picker had
 *  its own white disc, its own font and its own stroke, reading as a
 *  different object from the board's shape-coded badge sitting inches away
 *  in the same window. There is now exactly one implementation of what a
 *  value looks like, and both callers go through it.
 *
 *  What stayed behind in `drawValueBadge` is PLACEMENT, not art -- the
 *  13-slot search, dead-edge avoidance and per-hex overrides all need a
 *  board position (`q`/`r`) and a live `mapGrid`, none of which an isolated
 *  tray thumbnail has. The caller decides WHERE; this decides WHAT.
 *
 *  `terrain` still drives `VALUE_BADGE_SHAPE` (design note #62's shape-coded
 *  iconography), which is why it is passed rather than just a number. */
function drawValueBadgeAt(
  ctx: CanvasRenderingContext2D,
  badgeCenter: { x: number; y: number },
  size: number,
  terrain: "SmallTown" | "DoubleTown" | "MajorCityHub" | "DoubleCityHub",
  value: number,
): void {
  const label = `${value}`;
  const fontSizePx = Math.max(9, size * 0.2) - 1;
  ctx.font = `bold ${fontSizePx}px ${FONT_FAMILY_STACK}`;
  const shape = VALUE_BADGE_SHAPE[terrain];
  const badgeRadius = badgeRadiusForLabel(ctx.measureText(label), fontSizePx, shape, 2, 1.5, 5);

  // Design note #62: solid white fill/dark-navy stroke, shape-coded by
  // terrain (square for MajorCityHub/DoubleCityHub, diamond for
  // SmallTown/DoubleTown) -- REPLACES the old per-terrain color-coded
  // circle fill (`VALUE_BADGE_COLOR`).
  drawBadgeShape(ctx, badgeCenter, badgeRadius, shape);

  // Bold black text -- no halo/stroke needed (unlike the old white-on-
  // color-fill text, black-on-white already has full contrast on its own).
  ctx.fillStyle = "#000000";
  ctx.font = `bold ${fontSizePx}px ${FONT_FAMILY_STACK}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, badgeCenter.x, badgeCenter.y);
}

/** The per-tile overlay pass: revenue badge, then restriction label --
 *  design notes #126/#127.
 *
 *  One place so all three `drawTrackPath` exits (double-town, disjoint-path,
 *  fan) get identical treatment instead of each remembering to draw both.
 *
 *  `showRevenue` is false from the main BOARD loop only: laid hexes already
 *  get a badge from `drawValueBadge`'s own placement-aware pass, which knows
 *  about off-board tiers and per-hex value overrides, so drawing here too
 *  would stamp two numbers on one hex. The restriction label is NOT gated
 *  the same way -- `drawRestrictionBadge` labels the HEX (and only the nine
 *  real B/NY/OO hexes), whereas this labels the TILE, which is a different
 *  statement: it tells you what the piece in your hand is restricted to,
 *  which is exactly what the tray needs and what the board's hex badge
 *  cannot say. */
function drawTileOverlays(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
  entry: TileCatalogEntry,
  showRevenue: boolean,
  /** Design note #132: the chain's `MapTileEntry.revenue` for this tile.
   *  When present it REPLACES `terrainBaseValue` outright -- including when
   *  it is `0`, which is a real answer meaning "this tile earns nothing"
   *  and correctly suppresses the badge. Only `undefined` (a contract that
   *  predates Audit G-11, or a tray thumbnail with no chain record) falls
   *  back to the terrain bucket. */
  revenueOverride?: number,
): void {
  if (showRevenue) {
    const badgeTerrain = valueBadgeTerrainFor(entry.terrain);
    // Design note #135: THE precedence chain for what a badge prints, most
    // authoritative first.
    //
    //   1. `revenueOverride` -- the chain's own `MapTileEntry.revenue` for a
    //      tile actually laid on the board. Only the board pass has one.
    //   2. `entry.revenue` -- this file's mirror of `hexmap::TILE_CATALOG`'s
    //      printed figure. THIS is what the tile picker and offline mode
    //      resolve to: a tray thumbnail has no chain record because the tile
    //      is not on the board yet, and offline there is no chain at all.
    //   3. `terrainBaseValue` -- the flat per-terrain bucket, now a genuine
    //      last resort. It is reached only by plain connector track (which
    //      correctly buckets to `0` and draws no badge) or by a tile id
    //      missing from the mirror.
    //
    // `??` throughout, deliberately, NOT `||`. A revenue of `0` is a
    // legitimate answer at every level and must beat the level below it;
    // `||` treats it as absent and falls through to exactly the wrong number
    // this chain exists to stop printing.
    const value = revenueOverride ?? entry.revenue ?? terrainBaseValue(entry.terrain);
    if (badgeTerrain && value > 0) {
      // Same offset convention as `drawValueBadge`'s own slot placement
      // (`REVENUE_BADGE_OFFSET`), pointed south-east -- a tray thumbnail has
      // no board neighbours to dodge, so it takes a fixed, predictable
      // corner instead of running the 13-slot search.
      const badgeCenter = { x: center.x + size * 0.46, y: center.y + size * 0.5 };
      drawValueBadgeAt(ctx, badgeCenter, size, badgeTerrain, value);
    }
  }

  const label = restrictionLabelFor(entry.terrain);
  if (label) {
    // Design note #129: the SAME `RESTRICTION_BADGE_OFFSET` distance the
    // board uses (0.65 of hex size from centre), pointed due north. A tray
    // thumbnail has no neighbours or dead edges to dodge, so it takes a
    // fixed, predictable slot rather than running the board's 13-slot
    // search -- but the distance, font, colour and background-less styling
    // all come from the shared renderer, not from here.
    const badgeCenter = { x: center.x, y: center.y - size * 0.65 };
    drawRestrictionBadgeAt(ctx, badgeCenter, size, label);
  }
}

/** Maps a tile's real terrain onto the four badge-shape buckets
 *  `VALUE_BADGE_SHAPE` defines -- design note #126. `BostonHub` is a
 *  single-station city and `NewYorkHub` a two-station one, exactly as
 *  `archetypeForTerrain` already classifies them, so they borrow those
 *  buckets rather than inventing two more shapes for the same kind of
 *  revenue centre. `null` for terrain with no revenue at all, which is the
 *  signal to draw no badge. */
function valueBadgeTerrainFor(
  terrain: TerrainType,
): "SmallTown" | "DoubleTown" | "MajorCityHub" | "DoubleCityHub" | null {
  switch (terrain) {
    case "SmallTown":
      return "SmallTown";
    case "DoubleTown":
      return "DoubleTown";
    case "MajorCityHub":
    case "BostonHub":
      return "MajorCityHub";
    case "DoubleCityHub":
    case "NewYorkHub":
      return "DoubleCityHub";
    default:
      return null;
  }
}

/** The "B" / "NY" / "OO" restriction label a tile carries, or `null` --
 *  design note #127.
 *
 *  Derived from terrain rather than stored as a new catalog column, because
 *  here the two are the same fact: `hexmap.rs` defines `BostonHub`/
 *  `NewYorkHub`/`DoubleCityHub` precisely AS "the artwork legal only at the
 *  B / NY / OO labelled hexes" (module doc comments #18/#26/#27). A `label`
 *  column would be a second copy of something the terrain already says, free
 *  to drift out of sync with it.
 *
 *  NOTE on the tiles named in the request: #57, #63 and #45 do NOT carry a
 *  label. #57 is the ordinary yellow city every plain-city hex starts from,
 *  #63 the ordinary brown city, #45 an ordinary brown plain -- none is
 *  restricted to particular hexes in real 1830, and labelling them would
 *  tell the player something untrue about where they may be laid. The nine
 *  that really are label-restricted: #53/#61 (B), #54/#62 (NY),
 *  #59/#64/#65/#66/#67/#68 (OO). */
function restrictionLabelFor(terrain: TerrainType): "B" | "NY" | "OO" | null {
  switch (terrain) {
    case "BostonHub":
      return "B";
    case "NewYorkHub":
      return "NY";
    case "DoubleCityHub":
      return "OO";
    default:
      return null;
  }
}

/* Design note #129 deleted `drawTileRestrictionLabel` from here -- the
   bespoke white-pill label the picker drew for itself. It did not match the
   board, which draws these as plain bold black text with NO background
   (design note #47 removed the background from them deliberately). The tile
   pipeline now calls `drawRestrictionBadgeAt`, the single extracted
   implementation the board's own badge also goes through. */


/** Canonical Tile Upgrade Restrictions (design note #47, mirroring
 *  `hexmap.rs` module doc comment #26): draws one small, high-contrast "B"
 *  / "NY" / "OO" restriction badge at the hex's own upper-left CORNER
 *  (the literal geometric vertex, via `cornerAngleRad`/`pointOnCircle`,
 *  pulled in slightly so it doesn't sit on the border line itself) -- a
 *  fixed corner (unlike `drawValueBadge`'s own adaptive `BADGE_CORNERS`
 *  search), since this file's own three restricted hexes' printed track is
 *  already known and fixed: Boston's `LANDMARK_TRACKS` (`edges: [1, 5]`,
 *  NE-to-SE) and New York's (`edges: [1]`/`edges: [4]`, NE/SW stubs) both
 *  keep the upper-left corner clear, and the four OO hexes have no printed
 *  track at all (`OO_DESIGNATED_HEXES`' real source entries carry no
 *  `path=` data) -- so one consistent corner works for all three restricted
 *  kinds, giving players one predictable place to look rather than a
 *  per-hex adaptive one.
 *
 *  Deliberately placed at the true corner (`apothem * 0.85` out from
 *  center), NOT `drawValueBadge`'s own `size * 0.65` mid-radius "corner"
 *  zone (design note #109, was `0.44`, then briefly `0.38`, then `0.55`) --
 *  Boston and New York both also carry a real, non-zero
 *  `HEX_START_VALUE_OVERRIDE` value badge (design note #35) that renders
 *  unconditionally (not gated on tile-laid state the way this badge is),
 *  and that badge's own `BADGE_CORNERS` search can independently resolve
 *  to upper-left too. Sharing the same mid-radius zone risked a genuine
 *  overlap between the two badges on the exact two hexes this feature
 *  targets; sitting further out, in the hex's actual corner margin, keeps
 *  this badge in a visually distinct band regardless of which corner the
 *  value badge picks -- true to the request's own "upper corner/margin"
 *  wording besides. HONEST CAVEAT, not silently assumed away: on the four
 *  OO hexes specifically, corner 3 sits fairly close underneath the
 *  stacked two-line OO name pass above it (both land in a similar upper-
 *  left-ish band) -- close but not a hard, verified overlap; flagged here
 *  since this badge is new and untested in the live renderer, rather than
 *  claimed collision-free without having actually measured it on screen.
 *

 *  Purely informational: this badge carries no enforcement of its own (the
 *  backend's `legal_tile_placements` query is the single source of truth
 *  the tile picker already reflects automatically, `hexmap.rs` module doc
 *  comment #26's own closing paragraph) -- deliberately NOT gated by the
 *  `showCityNames` toggle (design note #42), since this is a rules/
 *  legality marker, not a city name; callers gate it on `!hexHasLaidTile`
 *  instead, matching the request's own explicit "before tiles are laid"
 *  framing -- once the correct restricted tile is actually laid, the
 *  restriction has been satisfied and re-showing the badge would be
 *  redundant, the same physical-board-parity reasoning nameplate
 *  suppression already uses. */
/** Restriction Labels (design note #49's plain-text/persistence reversals
 *  of #47 still stand -- see that note's own text below for the history;
 *  design note #55's Universal Canvas Layout Engine changed two things on
 *  top of it, and design note #69 REMOVES the shield box #55 itself added):
 *  - Shield box REMOVED (design note #69): reported, the badge's own tight
 *    tier-colored `drawLabelWithBackground` box (added by #55, reversing
 *    #49's original "no background pill/box" call) made "B"/"NY"/"OO" read
 *    as sitting on a distinct plate rather than printed directly on the
 *    hex/tile -- exactly what a real 1830 tile's own upgrade-restriction
 *    lettering looks like (plain ink straight on the printed tile face, no
 *    box). `background: false` (the same escape hatch
 *    `drawBoardMarginLabels` already uses) skips the box entirely; `text`
 *    now paints directly over whatever terrain/tier fill is under it.
 *  - Text un-bolded and sized up 1pt (design note #69, same pass): `"bold"`
 *    -> `undefined` (no weight override), base/min font `10`/`7` ->
 *    `11`/`8`.
 *  - Corner choice was ARCHETYPE-driven (unchanged from #55 through #104):
 *    a SingleCity hex's nameplate occupied the upper-left wedge
 *    (`singleNodeNameplateAnchor`), so its restriction badge (`archetype
 *    !== "DoubleCity"`) moved to the TOP-RIGHT wedge instead, clear of both
 *    the nameplate and the single center-locked station node, while a
 *    DoubleCity hex (nameplate dead-center, station nodes on the
 *    top-right/bottom-left diagonal) kept the UPPER-LEFT wedge, the
 *    ORIGINAL fixed corner from #47/#49 -- so the two archetypes preferred
 *    OPPOSITE corners of each other. Design note #105 UNIFIES this, per
 *    direct request: now that nameplates prefer center/top/bottom instead
 *    of upper-left (#105's own `NAMEPLATE_SLOT_PREFERENCE` change), the
 *    archetype-driven split this paragraph describes no longer reflects a
 *    real collision-avoidance need -- both archetypes now share the SAME
 *    preference (`RESTRICTION_SLOT_PREFERENCE_DOUBLE_CITY` ===
 *    `RESTRICTION_SLOT_PREFERENCE_OTHER`, Upper-Left then Upper-Right then
 *    every edge), left as two separately named constants only so a future
 *    pass CAN diverge them again without disturbing this function's own
 *    call site. */
// Design note #70: restriction-badge corner preference lists, expressed as
// 13-slot corner-slot numbers -- DoubleCity keeps its original fixed corner
// (slot 12/upper-left, `cornerIndex 3`) FIRST, SingleCity/other keeps slot
// 8/upper-right (`cornerIndex 1`) FIRST, exactly matching the old fixed
// literals below both preference lists. Unlike the old code, a genuine
// fallback now exists if that first-preference corner is ever blocked by
// live track: the opposite upper corner next, then both lower corners.
// Design note #76: same far-side-fallback reasoning as `BADGE_SLOT_PREFERENCE`
// just above -- if a DoubleCity hex is crowded enough that even slot 12
// (this list's own strong first preference, and the one G19 itself always
// gets in practice) is somehow unavailable, the fallback should still favor
// the far side over drifting into whatever near-side cluster the terrain
// icon/cost label are using.
//
// Design note #105: UNIFIED and REORDERED, per direct request -- both
// archetypes now lead with (what the request calls) "Vertex 5" and
// "Vertex 1", this system's own slot 12 (Upper-Left corner) and slot 8
// (Upper-Right corner) respectively (DoubleCity's list already led with
// exactly these two, unchanged; SingleCity/other's is reordered to match),
// THEN all six edge midpoints ("check edges"), in ascending slot order --
// reachable for the first time now that `drawRestrictionBadge` below no
// longer restricts its fallback pool to `CORNER_SLOTS` (see that function's
// own doc comment). `extendSlotPreference`'s default full-1-12 pool still
// appends the remaining, non-preferred corners as the final, least-likely
// fallback tail automatically -- no need to hand-list them here.
const RESTRICTION_SLOT_PREFERENCE_DOUBLE_CITY: readonly number[] = [12, 8, 1, 2, 3, 4, 5, 6];
const RESTRICTION_SLOT_PREFERENCE_OTHER: readonly number[] = [12, 8, 1, 2, 3, 4, 5, 6];

function drawRestrictionBadge(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
  text: "B" | "NY" | "OO",
  archetype: HexArchetype,
  mapGrid: MapGridResponse,
  q: number,
  r: number,
  // Design note #72: shared cross-pass claiming ledger (see
  // `claimHexSlot`'s own doc comment) -- lets this badge avoid whichever
  // slot the terrain icon/cost-label/revenue-badge passes already claimed
  // on this same hex this render, instead of every pass picking
  // independently and possibly landing on the exact same corner.
  claimedHexSlots: Map<string, Set<number>>,
): void {
  const restrictionOverride = resolveSlotOverride(q, r, "restriction");
  const preference = withSlotReserve(
    q,
    r,
    "restriction",
    archetype === "DoubleCity" ? RESTRICTION_SLOT_PREFERENCE_DOUBLE_CITY : RESTRICTION_SLOT_PREFERENCE_OTHER,
  );
  const blocked = hexBlockedSlots(mapGrid, q, r);
  const dead = slotsBlockedByEdges(deadEdgesAt(q, r), false);
  // Design note #105: no longer passes `CORNER_SLOTS` as the fallback
  // pool -- per direct request ("prefer Vertex 5 and 1, then check
  // edges"), this badge can now genuinely land on an edge midpoint, so its
  // fallback tail needs access to every slot (the default full 1-12
  // pool), not just corners. `badgeCenter` below is generalized to match
  // (via `hexSlotDirection`, which already handles edge slots correctly),
  // so there's no longer a rendering-path reason to exclude edges either.
  const slot = claimHexSlotPreferring(claimedHexSlots, q, r, restrictionOverride, preference, blocked, dead);
  // Design note #105: generalized from the old corner-only
  // `cornerAngleRad(CORNER_SLOT_TO_CORNER_INDEX[slot - 7])` formula to
  // `hexSlotDirection(slot)`, which resolves the correct true angle for
  // EITHER a corner slot or an edge slot -- the same helper every other
  // slot-based placement in this file already uses.
  // Design note #125: offset CHANGED from `apothem * 0.7` (~0.606 * size)
  // to a flat `size * 0.65`, per direct request to match the revenue
  // badge's own `REVENUE_BADGE_OFFSET` (design note #109) and the compound
  // terrain icon+cost badge's own `COMPOUND_BADGE_OFFSET` (design note
  // #122) -- all three badge types now share the exact same `0.65`
  // magnitude, measured the exact same way (straight `size * 0.65` along
  // `hexSlotDirection(slot)`, not an apothem-relative fraction), so a
  // restriction badge sitting on the same slot a revenue/terrain badge
  // could otherwise claim lands at the identical radius they would have.
  // Still safely inside the hex boundary at any of the 12 perimeter
  // angles (an edge midpoint, the nearest boundary point, sits at the full
  // apothem, ~0.866 * size, well outside this radius).
  const RESTRICTION_BADGE_OFFSET = 0.65;
  const direction = hexSlotDirection(slot);
  const badgeCenter = {
    x: center.x + direction.x * size * RESTRICTION_BADGE_OFFSET,
    y: center.y + direction.y * size * RESTRICTION_BADGE_OFFSET,
  };

  // Design note #124: base font dropped 2pt (11 -> 9), per direct request,
  // and switched to bold (was unweighted, the empty `""` fourth argument)
  // -- same "base drops, `fitFontSize`'s own `minFontSizePx` floor (8)
  // stays put" convention this file's other badges use for a plain point
  // drop (e.g. `drawTerrainCompoundBadge`'s own design note #92/#95/#99).
  drawRestrictionBadgeAt(ctx, badgeCenter, size, text);
}

/** THE restriction-label artwork -- design note #129.
 *
 *  Extracted VERBATIM from `drawRestrictionBadge` above, for the same reason
 *  design note #126 extracted `drawValueBadgeAt`: the tile picker had grown
 *  its own label renderer, and it did not match. Mine drew a white rounded
 *  pill with a dark outline; the board draws plain bold black text on no
 *  background at all -- design note #47's own reversal, which deliberately
 *  removed a background from these badges. Two labels in one window, styled
 *  as different objects.
 *
 *  `drawRestrictionBadge` keeps everything above this line, which is all
 *  PLACEMENT: the 13-slot search, `hexBlockedSlots`, dead-edge avoidance and
 *  the cross-pass claiming ledger, none of which an isolated tray thumbnail
 *  can supply (they need `mapGrid`, `q`, `r`). The caller decides WHERE;
 *  this decides WHAT, and there is now exactly one answer to that. */
function drawRestrictionBadgeAt(
  ctx: CanvasRenderingContext2D,
  badgeCenter: { x: number; y: number },
  size: number,
  text: "B" | "NY" | "OO",
): void {
  ctx.font = fitFontSize(ctx, text, 9, size * 0.5, 8, "bold");
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#000000";
  drawLabelWithBackground(ctx, text, badgeCenter, { background: false });
}

/** Draws a landmark's authentic, fixed starting track (see `LANDMARK_TRACKS`
 *  and design note #6b) -- NOT derived from any connection bitmask, since a
 *  landmark's pre-printed track is not a laid tile. Each segment is drawn
 *  independently: a 2-edge segment is a through-route with one shared
 *  station at hex center (mirroring `drawTrackPath`'s opposite/curve split
 *  above); a 1-edge segment (New York's two disconnected stubs) draws a
 *  short stub from the edge partway toward center, with its own station
 *  positioned there so New York's two stations don't overlap each other. */
function drawLandmarkTrack(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
  segments: ReadonlyArray<{ edges: readonly number[] }>,
): void {
  const apothem = size * (Math.sqrt(3) / 2);
  const edgePoint = (edgeIndex: number) => pointOnCircle(center, apothem, edgeAngleRad(edgeIndex));

  segments.forEach((segment, segmentIndex) => {
    // BUG FIX ("G19 Thin Track" -- reported: New York's track renders much
    // thinner than every other hex's track). Root cause: `drawStationCircle`
    // (called at the end of each segment's branch below, once per station)
    // sets `ctx.lineWidth = Math.max(2, size * 0.06)` for its own circle
    // outline and never restores it afterward. New York is the only
    // landmark with TWO segments in this loop (its "one hex, two
    // disconnected stations" design, see `LANDMARK_TRACKS`'s doc comment)
    // -- Boston/Baltimore each have exactly one, so their single track
    // stroke always happens before their one `drawStationCircle` call ever
    // runs and is never affected. New York's SECOND segment, though, draws
    // its own track stroke AFTER the first segment's `drawStationCircle`
    // call already shrank `ctx.lineWidth` down to the thin circle-outline
    // value -- with nothing in between to set it back, that second stub
    // rendered at barely half this function's intended track width. Setting
    // the track's stroke style fresh at the TOP of every loop iteration
    // (rather than once before the loop) guarantees each segment's own
    // stroke always uses the correct track width, regardless of what a
    // prior segment's station circle left behind.
    ctx.strokeStyle = "#2b2b2b";
    ctx.lineWidth = Math.max(3, size * 0.12);
    ctx.lineCap = "round";

    if (segment.edges.length === 2) {
      const [a, b] = segment.edges;
      const start = edgePoint(a);
      const end = edgePoint(b);
      const isOpposite = Math.abs(b - a) === 3;

      // BUG FIX (Revenue Center Connectivity pass -- see `drawPrintedTrack`'s
      // identical fix for the full derivation): `arcTo` cuts the corner at
      // `center` by construction and never actually touches it. Boston/
      // Baltimore's real edge pairs happen to be 120 degrees apart, where
      // the old `curveRadius = size * 0.6` leaves only a `~0.09 * size` gap
      // -- small enough to usually hide under `drawStationCircle`'s `0.22 *
      // size` radius -- but that's a coincidence of these two hexes' exact
      // edges, not a guarantee, and it's the same fragile pattern that
      // visibly broke for the gray hexes' more common 60-degree pairs.
      // Replaced with the same two-`quadraticCurveTo`-halves technique,
      // each with a guaranteed-exact endpoint at `center.x, center.y`.
      if (isOpposite) {
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
      } else {
        // Rail Map Overhaul (design note #42): two perpendicular-entering
        // cubic-Bezier halves via `bezierTrackSegment`, replacing the
        // previous `quadraticCurveTo`-based `curveHalf` closure -- same
        // "guaranteed-exact endpoint at center" property this BUG FIX
        // originally required, now via a Bezier curve instead of a
        // quadratic one.
        bezierTrackSegment(ctx, start, center, size, edgeInwardNormal(a), null);
        bezierTrackSegment(ctx, center, end, size, null, edgeInwardNormal(b));
      }

      drawStationCircle(ctx, center, size);
    } else if (segment.edges.length === 1) {
      const edgeEnd = edgePoint(segment.edges[0]);
      // A dead-end stub, curving in from the printed edge to the SAME
      // canonical diagonal node `stationMarkerPoint` anchors its token
      // marker to (design note #56: segment index 0 = Node Index 0 =
      // Top-Right/NE via `center + doubleNodeOffset`; segment index 1 =
      // Node Index 1 = Bottom-Left/SW via `center - doubleNodeOffset`) --
      // NOT the old independently-computed "50% of the way from this
      // segment's own edge toward center" approximation, which could land
      // at a different pixel than `stationMarkerPoint`'s point and let the
      // real printed track visually detach from its own token marker.
      // `LANDMARK_TRACKS["New York"]`'s segment order already encodes this
      // (segment 0 = edge 1/NE, segment 1 = edge 4/SW), so this stays a
      // purely structural, non-hardcoded mapping -- `segmentIndex` indexes
      // directly into `twoNodePositions`' own 2-tuple (design note #58), no
      // re-derived arithmetic. Rail Map Overhaul (design note #42): a
      // perpendicular-entering Bezier curve (`bezierTrackSegment`) instead
      // of a straight `lineTo` stub.
      const stubStation = twoNodePositions(center, size)[segmentIndex];

      bezierTrackSegment(ctx, edgeEnd, stubStation, size, edgeInwardNormal(segment.edges[0]), null);

      drawStationCircle(ctx, stubStation, size);
    }
  });
}

/** Draws an off-board hex's pre-printed track stubs -- see `OFFBOARD_TRACKS`
 *  and design note #10. A short stub line from each live edge partway
 *  toward the hex's center, deliberately with NO station circle (unlike
 *  `drawLandmarkTrack` above) -- an off-board hex is a revenue
 *  destination, not a real station a train can dwell at. */
function drawOffboardTrack(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
  edges: readonly number[],
): void {
  const apothem = size * (Math.sqrt(3) / 2);
  const edgePoint = (edgeIndex: number) => pointOnCircle(center, apothem, edgeAngleRad(edgeIndex));

  ctx.strokeStyle = "#2b2b2b";
  ctx.lineWidth = Math.max(3, size * 0.12);
  ctx.lineCap = "round";

  // Rail Map Overhaul (design note #42): each stub is now a
  // perpendicular-entering Bezier curve (`bezierTrackSegment`) instead of a
  // straight `lineTo` stub, matching every other track-drawing function in
  // this file.
  for (const edge of edges) {
    const edgeEnd = edgePoint(edge);
    const stubEnd = {
      x: center.x + (edgeEnd.x - center.x) * 0.55,
      y: center.y + (edgeEnd.y - center.y) * 0.55,
    };
    bezierTrackSegment(ctx, edgeEnd, stubEnd, size, edgeInwardNormal(edge), null);
  }
}

/** Draws a pre-printed gray hex's fixed track + station/dit/none marker --
 *  see `GRAY_HEXES` and design note #12. Generalizes `drawLandmarkTrack`'s
 *  1-edge (dead-end stub) and 2-edge (through-route) cases to also handle
 *  3+ edges (a curved multi-spur junction, matching `drawTrackPath`'s
 *  multi-spur handling), since two real gray hexes (Rochester, Altoona)
 *  have three real live edges converging on one city.
 *
 *  Item 6 (Authentic Preprinted Gray Track Curves): every segment here
 *  now curves cleanly INTO the station/dit marker rather than stopping
 *  short of it or meeting it via a straight spoke -- a 1-edge dead-end
 *  stub now runs the full distance to hex center (where its own marker
 *  sits, matching the 2-edge/3+-edge cases below, instead of the previous
 *  pass's shortened halfway stub with the marker floating off-center), and
 *  a 3+-edge junction now draws each spoke as a gentle `quadraticCurveTo`
 *  bend into center instead of a straight radial line, so the track reads
 *  as authentic curved 1830 tile artwork "snapping into" the station hole
 *  rather than a generic straight-line stub. The 2-edge case already had
 *  real curve/straight-through logic (unchanged here) -- see the
 *  `isOpposite` branch below, identical to `drawTrackPath`'s own.
 *
 *  Item (Precise Geometric Track Calibration pass): `bypass`, when set on a
 *  true opposite-edge pair (the only shape the real source's bypass paths
 *  ever take -- see `GrayHexTrack.bypass`'s doc comment), draws a SECOND
 *  curve between the same two edges via `quadraticCurveTo`, bowed well off
 *  the straight chord so it visibly clears the station circle instead of
 *  passing through it -- Altoona's real "some trains skip this stop" fork,
 *  reinstated after being simplified away in an earlier pass. */
function drawPrintedTrack(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
  edges: readonly number[],
  marker: "city" | "town" | "none",
  bypass?: boolean,
): void {
  const apothem = size * (Math.sqrt(3) / 2);
  const edgePoint = (edgeIndex: number) => pointOnCircle(center, apothem, edgeAngleRad(edgeIndex));
  const sorted = [...edges].sort((a, b) => a - b);

  ctx.strokeStyle = "#2b2b2b";
  ctx.lineWidth = Math.max(3, size * 0.12);
  ctx.lineCap = "round";

  // Every case's marker now sits at true hex center -- item 6's "snap
  // perfectly into the center holes" ask -- since no gray hex has more
  // than one single-edge dead-end stub of its own (unlike New York's two
  // independent landmark stations, which still need `drawLandmarkTrack`'s
  // own off-center offset to avoid overlapping each other).
  const markerPoint = center;

  if (sorted.length === 1) {
    // A gentle curve rather than a dead-straight radial line, so even a
    // single stub reads as authentic curved track, not a generic
    // ruler-straight stub. Rail Map Overhaul (design note #42):
    // perpendicular-entering cubic Bezier (`bezierTrackSegment`) instead of
    // the previous `quadraticCurveTo`.
    const edgeEnd = edgePoint(sorted[0]);
    bezierTrackSegment(ctx, edgeEnd, center, size, edgeInwardNormal(sorted[0]), null);
  } else if (sorted.length === 2) {
    const [a, b] = sorted;
    const start = edgePoint(a);
    const end = edgePoint(b);
    const isOpposite = b - a === 3;

    // BUG FIX (this pass, "Revenue Center Connectivity" -- reported: gray
    // preprinted hexes with a city/town marker and a NON-opposite 2-edge
    // pair render with the track visibly missing the marker at center).
    // Root cause: `arcTo(center, end, radius)` is a rounded-CORNER
    // primitive -- by construction it is tangent to, but never actually
    // touches, its own corner point for any `radius > 0`. The previous
    // `curveRadius = size * 0.6` made this far worse than a small visual
    // offset: the tangent length from the corner along each ray is `t =
    // radius / tan(angle / 2)`, and for this file's common 60-degree
    // adjacent-edge pairs (e.g. Cleveland/Montreal/Lansing/Atlantic City/
    // Fall River's edge pairs are all 60 degrees apart), `t ≈ 1.04 * size`
    // -- LONGER than the `apothem ≈ 0.866 * size` edge-to-center segment
    // itself, so the requested tangent point doesn't even exist within the
    // hex; the resulting arc genuinely does not approach center at all.
    // Even the one 120-degree case in this file (Kingston, C15) only
    // brings the curve to within `~0.09 * size` of center -- inside a
    // "town" dit's radius but not a "city" station's, and not a reliable
    // margin either way. Fixed the same way item 6 already fixed this
    // function's 1-edge and 3+-edge cases: two independent
    // `quadraticCurveTo` bends, edge-to-center and center-to-edge, each
    // with an explicit, guaranteed-exact endpoint at `center.x, center.y`
    // -- so the track always visibly connects to the marker drawn there,
    // while still reading as curved (not a sharp straight "V") through the
    // shared vertex. `isOpposite` keeps its own true straight-line case
    // unchanged (a real opposite pair is already exactly collinear through
    // center, so it never had this bug).
    if (isOpposite) {
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
    } else {
      // Rail Map Overhaul (design note #42): two perpendicular-entering
      // cubic-Bezier halves via `bezierTrackSegment`, replacing the
      // previous `quadraticCurveTo`-based `curveHalf` closure -- same
      // "guaranteed-exact endpoint at center" property this BUG FIX
      // originally required.
      bezierTrackSegment(ctx, start, center, size, edgeInwardNormal(a), null);
      bezierTrackSegment(ctx, center, end, size, null, edgeInwardNormal(b));
    }

    // Bypass fork: a second, independent curve between the SAME two edges
    // that loops well clear of the station circle at center (radius
    // `size * 0.22`, per `drawStationCircle`) rather than passing through
    // it -- only meaningful for a true opposite pair, since a non-opposite
    // pair's main route already curves away from center on its own. The
    // control point offset (`size * 0.8`, perpendicular to the start->end
    // chord) puts the curve's own peak deviation from that chord at roughly
    // half that -- `size * 0.4` -- comfortably outside the station circle
    // plus its stroke width, while staying inside the hex's own apothem
    // (`size * 0.866`) so the fork never bleeds into a neighboring hex.
    if (bypass && isOpposite) {
      // Rail Map Overhaul (design note #42): converted to `ctx.bezierCurveTo`
      // via the standard quadratic-to-cubic control-point elevation (`cp1 =
      // start + 2/3*(q - start)`, `cp2 = end + 2/3*(q - end)`) -- this
      // produces the EXACT SAME curve the single quadratic control point `q`
      // did, so the fork's already-verified "clears the station circle,
      // stays inside the hex" geometry is unchanged; only the drawing API
      // is. Left as its own dedicated wide loop (not `bezierTrackSegment`'s
      // perpendicular-normal profile) since this fork's whole purpose is to
      // swing FAR off the direct chord to avoid the station circle, not to
      // read as a perpendicular edge crossing.
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const len = Math.hypot(dx, dy) || 1;
      const bend = size * 0.8;
      const midX = (start.x + end.x) / 2;
      const midY = (start.y + end.y) / 2;
      const qx = midX + (-dy / len) * bend;
      const qy = midY + (dx / len) * bend;
      const cp1x = start.x + (2 / 3) * (qx - start.x);
      const cp1y = start.y + (2 / 3) * (qy - start.y);
      const cp2x = end.x + (2 / 3) * (qx - end.x);
      const cp2y = end.y + (2 / 3) * (qy - end.y);
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, end.x, end.y);
      ctx.stroke();
    }
  } else if (sorted.length >= 3) {
    // Item 6: each spoke bends gently into center (all bowed the same
    // rotational direction, so they read as one coherent curved junction)
    // instead of straight radial lines converging on the station. Rail Map
    // Overhaul (design note #42): perpendicular-entering cubic Bezier
    // (`bezierTrackSegment`) instead of the previous `quadraticCurveTo`.
    for (const edge of sorted) {
      const point = edgePoint(edge);
      bezierTrackSegment(ctx, point, center, size, edgeInwardNormal(edge), null);
    }
  }

  if (marker === "city") {
    drawStationCircle(ctx, markerPoint, size);
  } else if (marker === "town") {
    // Item 8 ("Distinct Dark Small Towns"): dark dit marker, not a white
    // circle -- see `drawDitMarker`'s own doc comment.
    drawDitMarker(ctx, markerPoint, size);
  }
}

/** Draws a pre-printed yellow "OO" double-city hex's two independent
 *  station circles -- see `YELLOW_OO_HEXES` and design note #12, geometry
 *  REPLACED by design note #49 (diagonal top-right/bottom-left, was
 *  left/right), offset formula UNIFIED into `doubleNodeOffset` by design
 *  note #55, and routed through the single shared `twoNodePositions` tuple
 *  helper by design note #58 (see that function's own doc comment). Real
 *  source data for these four hexes has no `path=` entry at all (no
 *  printed track connecting the two cities), so this deliberately draws NO
 *  line between them -- just two smaller station circles (`drawStationCircle`
 *  at a reduced size so both fit without overlapping). */
function drawOOCityMarkers(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
): void {
  const [node0, node1] = twoNodePositions(center, size);
  drawStationCircle(ctx, node0, size * 0.75); // index 0: top-right
  drawStationCircle(ctx, node1, size * 0.75); // index 1: bottom-left
}

/** Station Tokens (design note #36; extended by design note #44; geometry
 *  updated by design note #49; REWRITTEN by design note #55's Universal
 *  Canvas Layout Engine; NODE-INDEX INVERSION FIXED by design note #56):
 *  resolves the pixel point a Station Token marker at `(q, r)` should
 *  actually be drawn at -- true hex center for every ordinary single-node
 *  hex, but offset onto one of the two station nodes for any
 *  DoubleCity-archetype hex (see design note #36's own "board geometry
 *  special case" paragraph for why: two off-center circles mean a marker
 *  drawn at raw center would float visibly between both instead of sitting
 *  on either).
 *
 *  Design note #55 REMOVED the previous `hex.label === "G19"` literal
 *  string check (the Universal Layout Engine's own explicit prohibition on
 *  hardcoded per-hex identity branches) and replaced it with a STRUCTURAL
 *  one: is this hex a `LANDMARK_HEXES` entry whose own `LANDMARK_TRACKS`
 *  data has two independent one-edge stub segments (today, only New York --
 *  but any future landmark with the same real "two disconnected stations"
 *  printed-track shape would classify identically, with no code change
 *  here)? That structural check itself was correct and is unchanged.
 *
 *  Design note #56 FIXES a node-index inversion #55 introduced: the
 *  landmark branch anchored on `landmarkSegments[1]` (the SECOND/SW
 *  segment) for EVERY landmark-hosted token, which put New York's home
 *  token (NNH/"NYNH", `STATION_HOME_HEXES`) on the Bottom-Left/Southwest
 *  circle instead of its canonical Top-Right/Northeast one. Per the
 *  canonical rule shared by every 2-station archetype (`G19`, the four OO
 *  hexes, every double-town): Node Index 0 = Top-Right/Northeast =
 *  `center + doubleNodeOffset`; Node Index 1 = Bottom-Left/Southwest =
 *  `center - doubleNodeOffset`. `LANDMARK_TRACKS["New York"]`'s own segment
 *  ORDER already encodes this (`segments[0]` = edge 1/NE = Node 0;
 *  `segments[1]` = edge 4/SW = Node 1) -- the bug was reading index `[1]`
 *  unconditionally instead of the FIRST segment for the "assigned to node
 *  0" case. Rather than keep two independently-computed "close but not
 *  exact" approximations of the same two points (this function's old
 *  edge-interpolated 50%-to-center formula vs. `drawLandmarkTrack`'s own,
 *  which could drift apart pixel-for-pixel), both now anchor on the exact
 *  same literal `doubleNodeOffset` coordinates every other `DoubleCity`
 *  hex uses -- the request's explicit "without being swapped or offset"
 *  requirement, read as: no hex-specific custom offset, full literal
 *  unification. Every `DoubleCity`-archetype hex (`G19` included) now
 *  shares the exact same two node coordinates and the exact same Node
 *  0/Node 1 convention, with zero per-hex-name branching. */
function stationMarkerPoint(
  q: number,
  r: number,
  size: number,
  /** Design note #131: the tile actually laid on this hex, if any.
   *
   *  REQUIRED for correctness on any two-city hex once that hex holds a
   *  catalogued tile. `twoNodePositions` below returns a FIXED NE/SW
   *  diagonal that knows nothing about the tile's track, while the artwork
   *  puts each station on its own curve -- for #62 both cities sit in the
   *  upper half, nowhere near the SW node. Passing the laid tile keeps the
   *  token on the circle the player can see; omitting it leaves the old
   *  behaviour for an unlaid, still-blank designated hex, which is the one
   *  case where there is no artwork to follow. */
  laidTile?: MapTileEntry,
): { x: number; y: number } {
  const center = axialToPixel(q, r, size);

  if (laidTile) {
    const anchors = tileCityAnchors(laidTile.tile_id, laidTile.orientation, center, size);
    if (anchors.length > 0) {
      // Index choice is UNCHANGED from the logic below -- OO hexes take the
      // second station, New York the first -- so this moves where a token
      // is drawn without changing which city it is understood to occupy.
      const hexHere = STATIC_BOARD_HEXES.find((h) => h.q === q && h.r === r);
      if (hexHere && YELLOW_OO_HEXES.has(hexHere.label)) return anchors[1] ?? anchors[0];
      if (LANDMARK_HEXES.some((entry) => entry.q === q && entry.r === r)) return anchors[0];
      return anchors[0];
    }
  }

  const hex = STATIC_BOARD_HEXES.find((h) => h.q === q && h.r === r);
  if (hex && YELLOW_OO_HEXES.has(hex.label)) {
    // Index 1: bottom-left circle, mirrors `drawOOCityMarkers`'s own
    // placement -- both now read from the same `twoNodePositions` tuple
    // (design note #58) instead of hand-deriving the offset here.
    return twoNodePositions(center, size)[1];
  }
  const landmark = LANDMARK_HEXES.find((entry) => entry.q === q && entry.r === r);
  const landmarkSegments = landmark ? LANDMARK_TRACKS[landmark.name] : undefined;
  if (landmarkSegments && landmarkSegments.length >= 2) {
    // Structural "two real disconnected stub stations" signature (today,
    // only New York) -- Node Index 0 is always the canonical Top-Right/NE
    // node, matching `drawLandmarkTrack`'s own segment-index-0 anchor below
    // exactly (design note #56), both now reading from the same
    // `twoNodePositions` tuple (design note #58).
    return twoNodePositions(center, size)[0];
  }
  return center;
}

/** Draws one Station Token marker -- see design note #36, extended by
 *  design notes #45, #46, and #48. Sized to match `drawStationCircle`'s own
 *  `size * 0.22` radius exactly (the explicit "sized to match the large
 *  white city circles" ask), drawn ON TOP of whichever plain station circle
 *  already sits at this point. `muted` (true for a not-yet-floated
 *  corporation's preprinted home marker, false for any real placed token)
 *  swaps a solid dark-navy fill for the corporation's own solid `color`, so
 *  "reserved, not yet active" reads unmistakably differently from "an
 *  actual live token" at a glance. `ticker` is fit inside via the same
 *  `fitFontSize` helper every other in-canvas label in this file already
 *  uses (design note #46: floored at a minimum 9px here specifically, see
 *  that call's own comment), with a thin `strokeText` edge (design note
 *  #46: thinned down from #45's original `lineWidth = 2`, which was
 *  reported as choking small letterforms) painted first. Every real call
 *  site guarantees a non-empty `ticker` for every one of the 8
 *  `STATION_HOME_HEXES` entries (design note #45 / `stationTickerLabel`'s
 *  fallback) -- the `if (!ticker) return;` guard below is kept only as a
 *  defensive no-op for any future caller that doesn't, not because any
 *  current call site can hit it. */
function drawStationTokenMarker(
  ctx: CanvasRenderingContext2D,
  point: { x: number; y: number },
  size: number,
  ticker: string,
  color: string,
  muted: boolean,
): void {
  const radius = size * 0.22;

  // Design note #116: reserved/unfloated badges REVERSED from #46/#48's
  // solid-opaque-navy-plus-full-brand-ring treatment (which read as
  // deliberately as bold and "real" as an actual floated token) to a
  // heavily grayed-out, semi-transparent one instead -- direct request,
  // "show players that the station is reserved but not currently blocking
  // routes." Two changes, applied together: the fill drops from the dark
  // navy `#1E293B` to a neutral mid-gray (`#9CA3AF`, matching this file's
  // established muted/disabled tone elsewhere), and the ENTIRE muted badge
  // (fill, ring, and ticker text alike) now draws at a reduced
  // `globalAlpha` instead of full opacity -- "heavily grayed out... or
  // transparent... or something similar" was read as "combine both," since
  // gray alone can still look like a solid, present token, while adding
  // transparency on top makes it unmistakably a ghost/preview rather than
  // an active piece on the board. The ring KEEPS previewing the
  // corporation's own brand `color` (design note #48's own useful idea,
  // "which color it'll turn once floated") -- just faded along with
  // everything else now, rather than standing out at full strength while
  // the fill and text are grayed. Floated tokens are completely untouched:
  // this whole treatment is gated on `muted`.
  const badgeFill = muted ? "#9CA3AF" : color;
  const MUTED_ALPHA = 0.45;

  ctx.save();
  if (muted) ctx.globalAlpha = MUTED_ALPHA;

  ctx.beginPath();
  ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = badgeFill;
  ctx.fill();

  // Solid Corporate Brand Color Borders (design note #48, tone updated by
  // #116 above): the ring is still the corporation's own brand `color`, at
  // the same fixed, un-scaled `1.75px` (within the original 1.5px-2px
  // request) reserved/unfloated badges have used since #48 -- deliberately
  // NOT `size`-scaled like most of this file's other stroke widths, so it
  // reads as a thin, consistent ring at every zoom level. Floated badges'
  // own outline (`#f4ecd8`, solid, size-scaled) is unchanged.
  ctx.strokeStyle = muted ? color : "#f4ecd8";
  ctx.lineWidth = muted ? 1.75 : Math.max(2, size * 0.05);
  ctx.stroke();

  if (!ticker) {
    ctx.restore();
    return;
  }

  // Crisp Token Typography (design note #46): explicit system-sans font
  // stack (the request's own literal wording), and a 9px floor -- passed as
  // `fitFontSize`'s own `minFontSizePx` argument for THIS call site only,
  // not by changing `fitFontSize` itself, which seven other call sites
  // across this file share with their own independently-tuned minimums (as
  // low as 5px, for the tightest off-board value badges) that a shared
  // global floor would silently override and likely overflow.
  ctx.font = fitFontSize(ctx, ticker, 11, radius * 1.7, 9, "bold");
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // Crisp Token Typography (design note #46): whichever of pure white/pure
  // black actually contrasts better against THIS badge's own fill, computed
  // per-badge via `bestContrastTextColor` rather than one fixed color
  // asserted for every corporate ticker -- see that function's own doc
  // comment for the honest caveat that a few of `STATION_TICKER_COLORS`'s
  // own established brand colors (e.g. NYC's blue, ~4.9:1 best-case) don't
  // reach the literal 7:1 AAA threshold against EITHER pure color alone;
  // this is the best available flat-fill contrast without altering that
  // shared brand palette, which is out of scope here.
  const textColor = bestContrastTextColor(badgeFill);
  const haloColor = textColor === "#FFFFFF" ? "#000000" : "#FFFFFF";

  // Crisp Token Typography (design note #46): CORRECTS design note #45's
  // `lineWidth = 2` halo, reported as choking small letterforms (filling in
  // the counters of "B&O"/"B&M"/"C&O"'s tight glyphs) at this badge's small
  // `radius = size * 0.22`. Thinned to the requested `0.5` maximum and
  // recolored to the OPPOSITE of `textColor` (so it reads as a thin
  // contrast-boosting edge against the badge fill, not a thick outline
  // fighting the glyph fill) -- still painted BEFORE `fillText`, same
  // ordering #45 established.
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineWidth = 0.5;
  ctx.strokeStyle = haloColor;
  ctx.strokeText(ticker, point.x, point.y);
  ctx.restore();

  ctx.fillStyle = textColor;
  ctx.fillText(ticker, point.x, point.y);
  ctx.restore();
}

/** A small brown twin-peak mountain icon -- see design note #9. Drawn on a
 *  Mountain hex's now-standard land fill so the terrain reads as
 *  "buildable, at a cost" rather than the previous pass's solid-brown
 *  fill, which looked like a permanent obstacle. Two overlapping triangles
 *  (a smaller back peak, then a slightly larger front peak painted on top)
 *  read as a small mountain range rather than a single, less legible
 *  triangle.
 *
 *  Rail Map Overhaul (design note #42): scaled down ~30% (`size * 0.7`) from
 *  the hex's own radius, per that item's explicit "de-cluttering" ask -- the
 *  icon still anchors at the same `center`, just occupies visibly less of
 *  the hex, leaving more clearance for the track spline / cost label sharing
 *  the same tile.
 *
 *  Design note #87: `colorOverride`, when given, replaces both peaks' own
 *  fill AND stroke with one flat color -- used by `drawTerrainCompoundBadge`
 *  to render this icon in WHITE (matching its adjoined cost text) so it
 *  stays legible against that badge's solid red fill, where the icon's
 *  usual brown two-tone would be low-contrast. Omitted (the standalone
 *  terrain-icon pass), the normal brown two-tone renders unchanged. */
function drawMountainIcon(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
  colorOverride?: string,
): void {
  // Design note #101: `iconSize` bumped `size*0.7 -> size*0.875` (+25%),
  // per direct request -- every other dimension in this function (`w`,
  // `h`, `cx` offset, `cy` offset) is derived from `iconSize`, so this one
  // change scales the whole icon uniformly.
  // Design note #102: bumped another 30%, `size*0.875 -> size*1.1375`, per
  // direct follow-up request (same uniform-scale mechanism).
  const iconSize = size * 1.1375;
  const drawPeak = (offsetX: number, scale: number, fill: string) => {
    const w = iconSize * 0.5 * scale;
    const h = iconSize * 0.42 * scale;
    const cx = center.x + offsetX;
    const cy = center.y + iconSize * 0.06;
    ctx.beginPath();
    ctx.moveTo(cx - w / 2, cy + h / 2);
    ctx.lineTo(cx, cy - h / 2);
    ctx.lineTo(cx + w / 2, cy + h / 2);
    ctx.closePath();
    ctx.fillStyle = colorOverride ?? fill;
    ctx.fill();
    ctx.strokeStyle = colorOverride ?? "#3a2818";
    ctx.lineWidth = 1;
    ctx.stroke();
  };
  drawPeak(iconSize * 0.22, 0.7, "#5a3f28"); // smaller back peak, drawn first
  drawPeak(-iconSize * 0.05, 1, "#6b4a2f"); // main peak, painted on top
}

/** A blue water-wave icon across a buildable River hex -- see design note
 *  #9. Replaces a prior pass's solid-blue fill, which visually read as
 *  impassable water rather than buildable terrain.
 *
 *  Rail Map Overhaul (design note #42): scaled down ~30% (`size * 0.7`),
 *  matching `drawMountainIcon`'s identical treatment above, for the same
 *  de-cluttering reason.
 *
 *  Design note #86 REDESIGN: TWO thin, stacked parallel strands (was ONE,
 *  thicker curve) -- more legible as a "water" cartographic symbol, per
 *  direct request. Design note #88 FOLLOW-UP, per direct feedback on #86's
 *  first pass: (a) stroke width bumped back up 25% off #86's own value
 *  (`* 0.25` -> `* 0.3125` off the original pre-#86 formula) -- #86 alone
 *  read too thin; (b) the two strands pulled further apart (`iconSize *
 *  0.09` -> `* 0.16`); (c) RESHAPED from one gentle two-arc S-curve (read
 *  as a single river channel) to a proper tilde-style wave -- THREE
 *  alternating crests/troughs across the same overall width, the standard
 *  nautical-chart "water" glyph, via `drawWaveStrand` below -- rather than
 *  a shape a caller has to squint at to not read as "a river," per that
 *  same feedback. Design note #90 FOLLOW-UP: a third crest added (now
 *  THREE crests/two troughs total) within that same overall width and
 *  amplitude, per direct request -- later reverted (see #98 below), the
 *  "third wave" turning out to mean a third STRAND, not a third crest.
 *
 *  Design note #98 FOLLOW-UP: THREE stacked strands (was two) -- per
 *  clarified direct request, "a third wave" meant a third parallel line in
 *  the SAME shape as the existing two, not a third crest crammed into one
 *  line (#90/#96's approach, both reverted). `drawWaveStrand` itself is
 *  back to its original #90 shape (5 segments/three crests, two troughs);
 *  #95's amplitude bump (`0.16 -> 0.24`) is kept, unrelated to this
 *  strand-count question. The three strands sit at `-strandOffset`, `0`,
 *  `+strandOffset` -- same `strandOffset` gap between each ADJACENT pair
 *  as the old two-strand layout had between its only pair, just extended
 *  to a third line.
 *
 *  Design note #100 FOLLOW-UP: #98's third strand REMOVED, back to two,
 *  per direct request -- and `strandOffset` widened `0.16 -> 0.20` for
 *  slightly more separation between the two remaining strands.
 *
 *  `colorOverride` (design note #87): lets a caller render this icon in a
 *  single flat color instead of its normal blue -- unused by
 *  `drawTerrainCompoundBadge` as of design note #88 (that badge now draws
 *  the icon in its ordinary color, perched above the badge's red box
 *  rather than inside it), but left in place as a general-purpose escape
 *  hatch for any future caller that DOES need a flat override. */
function drawRiverIcon(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
  colorOverride?: string,
): void {
  const iconSize = size * 0.7;
  const halfW = iconSize * 0.68;
  // Design note #88: `* 0.3125` = the original pre-#86 formula's `* 0.25`
  // (#86's own -75% cut) times #88's own further `* 1.25` (+25% back up).
  const lineWidth = Math.max(3, iconSize * 0.14) * 0.3125;
  // Design note #100: bumped `0.16 -> 0.20` -- slightly more separation
  // between the two strands, per direct request, on top of reverting back
  // to two strands (#98's third strand removed).
  const strandOffset = iconSize * 0.2;
  // Design note #95: amplitude bumped `0.16 -> 0.24` -- #90's third crest
  // was mathematically present but too subtle to read at this icon's
  // small on-screen size (each crest's actual visual excursion is only
  // HALF `amplitude`, per a quadratic Bezier's own midpoint math -- see
  // `TERRAIN_ICON_SIZE_RATIO`'s doc comment), so five tightly-packed
  // segments at the old amplitude blurred into what still looked like the
  // old two-crest shape. Note this also grows the icon's own bounding
  // height, so `TERRAIN_ICON_SIZE_RATIO.River.height` below is updated to
  // match (width ratio is unaffected -- amplitude doesn't change `halfW`).
  const amplitude = iconSize * 0.24;
  const drawStrand = (dy: number) => {
    drawWaveStrand(ctx, center.x - halfW, center.x + halfW, center.y + dy, amplitude);
  };
  ctx.strokeStyle = colorOverride ?? "#3a7bbf";
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  // Design note #100: back to TWO strands (#98's third strand removed,
  // per direct request) at the widened `strandOffset` above.
  drawStrand(-strandOffset / 2);
  drawStrand(strandOffset / 2);
}

/** Design note #90 (segment count reverted here by design note #98):
 *  strokes ONE tilde-style wave -- THREE crests and two troughs (a rise, a
 *  fall, a rise, a fall, a rise) spanning `[startX, endX]` at vertical
 *  center `baseY`, each hump `amplitude` tall -- the standard
 *  nautical-chart "water" glyph. Design note #96 had briefly changed this
 *  to an EVEN 6-segment count (three full cycles) chasing a "still only
 *  reads as two waves" report -- that report turned out to mean something
 *  different (see #98): not "this one line needs a clearer third crest,"
 *  but "draw a THIRD PARALLEL LINE in this same shape" (`drawRiverIcon`
 *  briefly stroked three stacked strands instead of two -- since reverted
 *  back to two by design note #100, per direct follow-up request). This
 *  function is reverted back to its original 5-segment/#90 shape
 *  accordingly; the "third wave" attempt is now abandoned entirely (back
 *  to two strands, just spaced slightly further apart, #100). Assumes the
 *  caller has already set `ctx.strokeStyle`/`lineWidth`/`lineCap`/
 *  `lineJoin`; only builds and strokes the path. Shared by
 *  `drawRiverIcon`'s two stacked strands -- which is in turn shared by
 *  BOTH render paths, the standalone icon (Layer 1, simple hexes) and
 *  `drawTerrainCompoundBadge`'s perched icon (complex hexes) -- so any
 *  change here reaches both automatically, no
 *  separate per-call-site edit needed. */
function drawWaveStrand(
  ctx: CanvasRenderingContext2D,
  startX: number,
  endX: number,
  baseY: number,
  amplitude: number,
): void {
  const width = endX - startX;
  const segments = 5; // three crests, two troughs (design note #90/#98)
  const segment = width / segments;
  ctx.beginPath();
  ctx.moveTo(startX, baseY);
  for (let i = 0; i < segments; i++) {
    const direction = i % 2 === 0 ? -1 : 1; // even segments crest up, odd segments crest down
    const midX = startX + segment * (i + 0.5);
    const endSegX = startX + segment * (i + 1);
    ctx.quadraticCurveTo(midX, baseY + amplitude * direction, endSegX, baseY);
  }
  ctx.stroke();
}

/** Design note #87: shared Mountain/River icon dispatcher -- lets a caller
 *  (the compound badge below) pick the right icon function by `terrainType`
 *  without its own `hex.type === "Mountain" ? ... : ...` branch. */
function drawTerrainIcon(
  ctx: CanvasRenderingContext2D,
  terrainType: "Mountain" | "River",
  center: { x: number; y: number },
  size: number,
  colorOverride?: string,
): void {
  if (terrainType === "Mountain") {
    drawMountainIcon(ctx, center, size, colorOverride);
  } else {
    drawRiverIcon(ctx, center, size, colorOverride);
  }
}

/** Design note #89: exact rendered WIDTH/HEIGHT-to-`size`-argument ratios
 *  for `drawRiverIcon`/`drawMountainIcon`, derived directly from each
 *  function's own geometry (both scale linearly with their `size`
 *  argument, so one fixed ratio suffices) -- lets `drawTerrainCompoundBadge`
 *  size its icon to an EXACT target WIDTH (matching the red cost box's own
 *  width, per direct request) while still knowing exactly how tall that
 *  produces it, for the block's own vertical layout.
 *   - River: `iconSize = size*0.7`; the two wave strands span
 *     `iconSize*0.68*2` horizontally -> width ratio `0.7*1.36 = 0.952`
 *     (unaffected by strand count/spacing -- both strands share the same
 *     `halfW`). Each strand's own crest/trough excursion is HALF its
 *     control-point `amplitude` (a quadratic Bezier's midpoint value is
 *     `0.5 *` control-offset, not the full offset) -- `amplitude*0.5` on
 *     each side of its own baseline, `amplitude` total per strand;
 *     combined with the gap between the two strands' own baselines, total
 *     vertical span = `strandOffset + amplitude`. Design note #100: back
 *     to two strands (#98's third removed) with `strandOffset` widened
 *     `iconSize*0.16 -> iconSize*0.20` -- span is now `iconSize*(0.20 +
 *     0.24) = iconSize*0.44` -> height ratio `0.7*0.44 = 0.308` (was
 *     `0.392` for three strands, `0.28` for the original narrower
 *     two-strand spacing).
 *   - Mountain: `iconSize = size*1.1375` (design note #101: `size*0.7 ->
 *     size*0.875`, +25%; design note #102: `size*0.875 -> size*1.1375`,
 *     another +30% per direct follow-up request). Bounding WIDTH is the
 *     back (offset) peak's own right edge, the icon's rightmost point
 *     overall -> width ratio `1.1375*0.695 = 0.7905625`. Bounding HEIGHT
 *     is the larger main peak's own full triangle height (the smaller
 *     back peak shares the same vertical center and sits entirely inside
 *     the main peak's taller span) -> height ratio `1.1375*0.42 =
 *     0.47775`. */
const TERRAIN_ICON_SIZE_RATIO: Readonly<Record<"Mountain" | "River", { width: number; height: number }>> = {
  River: { width: 0.952, height: 0.308 },
  Mountain: { width: 0.7905625, height: 0.47775 },
};

/** Design note #87/#88: a compound badge adjoining a shrunken terrain icon
 *  with its build-cost figure as ONE unit -- REPLACES the standalone icon
 *  (Layer 1, the terrain-icon pass) plus separately-positioned cost box
 *  (Layer 4, this pass) for any "complex" hex -- one with a city, town, or
 *  real track (`isComplexHex` at both call sites) -- per explicit request.
 *
 *  Design note #88 REVISES #87's original layout: the icon no longer sits
 *  INSIDE the red cost box (icon left, text right, shared fill) -- per
 *  direct feedback, it now perches directly ABOVE the box instead, in its
 *  own ordinary terrain color (no `colorOverride`; it's no longer on the
 *  red fill, so it no longer needs a white override for contrast), tightly
 *  adjoined (a small fixed gap) so the two pieces still read as one
 *  combined unit. The box itself is back to holding ONLY the cost text,
 *  same red fill design note #68 established. Both pieces lay out as a
 *  vertically stacked block, centered on `anchor` (the SAME "combined
 *  block centered on one point" pattern design note #78c uses for the
 *  off-board nameplate+revenue block) -- so `anchor` still marks the ONE
 *  slot this whole badge claims, not either piece individually.
 *
 *  Design note #89: the icon is now sized to match the red box's own WIDTH
 *  EXACTLY, per direct request -- REPLACING #87/#88's "shrink to the cost
 *  text's cap-HEIGHT" rule, which left the icon's width essentially
 *  unrelated to the box underneath it. `TERRAIN_ICON_SIZE_RATIO` supplies
 *  the exact `size` argument that produces that target width (and the
 *  height that same `size` produces, for this function's own vertical
 *  layout) -- see that constant's own doc comment for the derivation.
 *  `anchor` is the ALREADY-RESOLVED single slot position the caller
 *  claimed for this whole badge -- unlike the old two-piece rendering (one
 *  slot for the icon, a second for the cost), this is ONE claim for ONE
 *  combined visual unit. */
// Design note #121: shrinks the ENTIRE compound badge (icon + cost box
// together, as one unit) by 35%, per direct request. Applied to the three
// inputs the whole badge's geometry derives from -- base font size,
// padding, and the icon/box gap -- rather than to `boxWidth`/`iconSize`
// themselves, since those are already CALCULATED from these inputs a few
// lines down; scaling the inputs once here lets that existing math do the
// rest (a smaller font -> smaller `textMetrics` -> smaller `boxWidth` ->
// (via `TERRAIN_ICON_SIZE_RATIO`) a smaller `iconSize` too, automatically,
// with no separate icon-specific scale needed). `minFontSizePx` scales
// alongside the base so the floor `fitFontSize` degrades to under a tight
// `maxWidthPx` shrinks proportionally rather than staying at the old,
// now-oversized-relative-to-everything-else floor.
const COMPOUND_BADGE_SHRINK = 0.65;

function drawTerrainCompoundBadge(
  ctx: CanvasRenderingContext2D,
  terrainType: "Mountain" | "River",
  costLabel: string,
  anchor: { x: number; y: number },
  maxWidthPx: number,
): void {
  // Design note #92: base font dropped 1pt (9 -> 8), same as the plain-hex
  // cost box, layered on top of #91's tightened box padding (kept, not
  // reverted) -- per direct request, both changes now apply together.
  // Design note #95: raised back 1pt (base `9`) now that the `$` prefix is
  // gone (#94), same as the plain-hex box.
  // Design note #99: raised another 1pt (base `10`), per direct request,
  // same as the plain-hex box.
  // Design note #121: base/floor both scaled by `COMPOUND_BADGE_SHRINK`
  // (10 -> 6.5, 6 -> 3.9) -- see that note above for why scaling the font
  // input is enough to shrink the whole badge.
  ctx.font = fitFontSize(
    ctx,
    costLabel,
    10 * COMPOUND_BADGE_SHRINK,
    maxWidthPx,
    6 * COMPOUND_BADGE_SHRINK,
    "bold",
  );
  const textMetrics = ctx.measureText(costLabel);
  const parsedFontSize = parseInt(ctx.font, 10) || 9;
  const textAscent = textMetrics.actualBoundingBoxAscent ?? parsedFontSize * 0.75;
  const textDescent = textMetrics.actualBoundingBoxDescent ?? parsedFontSize * 0.25;
  const textHeight = textAscent + textDescent;

  // Design note #91 REVERTED (design note #97): padding tried tightened
  // 3/2 -> 1/1, but per direct follow-up request this box is reverted
  // back to its original 3/2 padding, same as the plain-hex cost box.
  // Design note #121: both scaled by `COMPOUND_BADGE_SHRINK` (3 -> 1.95,
  // 2 -> 1.3), same 35% shrink as the font above.
  const paddingX = 3 * COMPOUND_BADGE_SHRINK;
  const paddingY = 2 * COMPOUND_BADGE_SHRINK;
  const boxHeight = textHeight + paddingY * 2;
  const boxWidth = textMetrics.width + paddingX * 2;

  // Design note #89: icon sized so its own rendered width equals `boxWidth`
  // exactly, perched directly above the box with a small gap between the
  // icon's own (resulting) bottom and the box's own top.
  const ratio = TERRAIN_ICON_SIZE_RATIO[terrainType];
  const iconSize = boxWidth / ratio.width;
  const iconRenderedHeight = iconSize * ratio.height;
  // Design note #93: widened 1.5 -> 3, per direct request -- the icon and
  // the red box were reading as directly touching; still small enough
  // that the two pieces read as one combined unit, not two separate ones.
  // Design note #121: scaled by `COMPOUND_BADGE_SHRINK` (3 -> 1.95), same
  // 35% shrink, so the gap stays visually proportional to the
  // now-smaller icon and box rather than reading as relatively wider.
  const iconGap = 3 * COMPOUND_BADGE_SHRINK;

  const totalHeight = iconRenderedHeight + iconGap + boxHeight;
  const blockTop = anchor.y - totalHeight / 2;

  const iconCenter = { x: anchor.x, y: blockTop + iconRenderedHeight / 2 };
  drawTerrainIcon(ctx, terrainType, iconCenter, iconSize);

  const boxY = blockTop + iconRenderedHeight + iconGap;
  const boxX = anchor.x - boxWidth / 2;
  const radius = Math.min(2, boxHeight / 2, boxWidth / 2);

  // Design note #68: same solid red this file's terrain-cost box has
  // always used -- now holds ONLY the cost text (design note #88 moved the
  // icon out of it, to perch above instead).
  fillRoundedRect(ctx, boxX, boxY, boxWidth, boxHeight, radius, "#E53E3E");

  ctx.fillStyle = "#FFFFFF";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(costLabel, anchor.x, boxY + boxHeight / 2);
}

/** Rail Map Overhaul (design note #42): paints a dark, translucent
 *  `strokeText` halo directly behind `text`, THEN the actual `fillText` on
 *  top -- the "Text Stroke Outline / Halos" requirement, so a label reads
 *  crisply at any zoom level even where it sits over a busy hex fill/track
 *  crossing rather than `drawLabelWithBackground`'s own solid contrast box.
 *  `lineJoin = "round"` keeps the halo from spiking at sharp glyph corners.
 *  Assumes the caller has already set `ctx.font`/`ctx.textAlign`/
 *  `ctx.textBaseline` (identical assumption to `drawLabelWithBackground`
 *  below, which this is a standalone sibling of for the handful of direct
 *  `ctx.fillText` call sites that don't go through that function's own
 *  background-box path). */
function fillTextWithHalo(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
): void {
  ctx.save();
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(0, 0, 0, 0.75)";
  ctx.lineWidth = 3;
  ctx.strokeText(text, x, y);
  ctx.restore();
  ctx.fillText(text, x, y);
}

/** Design note #84: fills a rounded rectangle -- extracted, behavior-
 *  identical, from `drawLabelWithBackground`'s own inline box-drawing block
 *  below (still used there) so `drawStackedNameLabel` can paint ONE shared
 *  box spanning two lines of text without duplicating this path-building
 *  logic a second time. */
function fillRoundedRect(
  ctx: CanvasRenderingContext2D,
  boxX: number,
  boxY: number,
  boxWidth: number,
  boxHeight: number,
  radius: number,
  fillStyle: string,
): void {
  ctx.save();
  // Item 8 (Track-Under-Text Layer Masking): the background plate itself
  // never carries a drop shadow, even when the caller has `ctx.shadowColor`/
  // `shadowBlur` set for text drawn just below -- scoped to just this rect
  // fill via save/restore.
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.fillStyle = fillStyle;
  ctx.beginPath();
  ctx.moveTo(boxX + radius, boxY);
  ctx.arcTo(boxX + boxWidth, boxY, boxX + boxWidth, boxY + boxHeight, radius);
  ctx.arcTo(boxX + boxWidth, boxY + boxHeight, boxX, boxY + boxHeight, radius);
  ctx.arcTo(boxX, boxY + boxHeight, boxX, boxY, radius);
  ctx.arcTo(boxX, boxY, boxX + boxWidth, boxY, radius);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Draws `text` centered at `point`, first painting a small translucent
 *  rounded-rectangle background sized to the actual measured text -- see
 *  design note #6c. This is what stops a legibly-sized label (per
 *  `fitFontSize`) from still visually colliding with a track stroke or
 *  another hex's fill/outline drawn underneath it. Assumes the caller has
 *  already set `ctx.font`/`ctx.fillStyle`(text color)/`ctx.textAlign`/
 *  `ctx.textBaseline` -- both call sites below set `textAlign`/`textBaseline`
 *  to `"center"`/`"middle"`, which this box-centering logic assumes.
 *
 *  `strokeHalo` (design note #42): also run `text` through
 *  `fillTextWithHalo`'s dark stroke-outline pass instead of a plain
 *  `ctx.fillText` -- belt-and-suspenders legibility on top of the
 *  background box above (or the ONLY legibility aid at all for the one
 *  caller, `drawBoardMarginLabels`, that sets `background: false` and
 *  floats its text with no box whatsoever). Default `false` so every
 *  existing call site's rendering is unchanged unless it opts in. */
function drawLabelWithBackground(
  ctx: CanvasRenderingContext2D,
  text: string,
  point: { x: number; y: number },
  options?: {
    paddingX?: number;
    paddingY?: number;
    fillStyle?: string;
    background?: boolean;
    strokeHalo?: boolean;
    /** Design note #51: overrides the box's corner rounding, otherwise
     *  `Math.min(6, boxHeight / 2, boxWidth / 2)` below. Every existing
     *  caller omits this and keeps that default; `drawHexNameLabel`'s new
     *  "18xx-Style Text Background Shield Box" passes a near-zero value for
     *  a genuinely RECTANGULAR box, per that request's own explicit
     *  wording, rather than the soft pill-like rounding every other caller
     *  still uses. */
    cornerRadiusPx?: number;
  },
): void {
  const paddingX = options?.paddingX ?? 4;
  const paddingY = options?.paddingY ?? 2;

  // `background` (design note #30/item 2) -- `false` skips the rounded-rect
  // contrast box entirely and just paints `text` directly, for the one
  // caller (`drawBoardMarginLabels`) that explicitly wants its labels
  // floating with no boxed frame around them. Every other call site omits
  // this option and keeps the box (default `true`), unchanged.
  if (options?.background ?? true) {
    const metrics = ctx.measureText(text);
    const textWidth = metrics.width;
    // Some canvas implementations only populate `width`, not the
    // bounding-box ascent/descent metrics -- fall back to a font-size-derived
    // estimate (parsed off the already-set `ctx.font` string) so the box is
    // still reasonably sized either way.
    const parsedFontSize = parseInt(ctx.font, 10) || 12;
    const ascent = metrics.actualBoundingBoxAscent ?? parsedFontSize * 0.75;
    const descent = metrics.actualBoundingBoxDescent ?? parsedFontSize * 0.25;
    const textHeight = ascent + descent;

    const boxWidth = textWidth + paddingX * 2;
    const boxHeight = textHeight + paddingY * 2;
    const boxX = point.x - boxWidth / 2;
    const boxY = point.y - boxHeight / 2;

    const radius = options?.cornerRadiusPx ?? Math.min(6, boxHeight / 2, boxWidth / 2);
    fillRoundedRect(ctx, boxX, boxY, boxWidth, boxHeight, radius, options?.fillStyle ?? "rgba(255, 255, 255, 0.72)");
  }

  // `ctx.fillStyle` here is whatever the caller set before calling this
  // function -- untouched by the `ctx.save()`/`ctx.restore()` pair above,
  // which only scoped the background box's own fill color.
  if (options?.strokeHalo) {
    fillTextWithHalo(ctx, text, point.x, point.y);
  } else {
    ctx.fillText(text, point.x, point.y);
  }
}

/** Measures `text` at `baseFontSizePx` and shrinks it (in 1px steps, down to
 *  `minFontSizePx`) until `ctx.measureText` confirms it fits within
 *  `maxWidthPx` -- see design note #3b. Returns the CSS font string to
 *  assign to `ctx.font`, at whichever size it settled on. `fontWeight` is
 *  the CSS font-weight/style prefix (e.g. `"bold"`, or `""` for normal).
 *
 *  Crisp Token Typography (design note #46): the font-family stack is now
 *  the explicit `system-ui, -apple-system, sans-serif` requested (was a
 *  bare `sans-serif`) -- applied here, for every one of this file's eight
 *  `fitFontSize` call sites at once, since a font-family substitution
 *  (unlike a shared size floor) carries no per-caller layout risk: it only
 *  swaps which real typeface the browser resolves a generic sans-serif
 *  request to, never changes measured glyph widths enough to threaten any
 *  caller's own `maxWidthPx` fit. Scoped to `fitFontSize` itself, not
 *  applied to this file's small number of OTHER, unrelated hardcoded
 *  `ctx.font = "...sans-serif"` strings outside this helper (e.g. the stock
 *  ticker panel's row/title fonts) -- those weren't part of this request
 *  and are left untouched rather than swept up incidentally. */
const FONT_FAMILY_STACK = "system-ui, -apple-system, sans-serif";

function fitFontSize(
  ctx: CanvasRenderingContext2D,
  text: string,
  baseFontSizePx: number,
  maxWidthPx: number,
  minFontSizePx: number,
  fontWeight: string,
): string {
  const prefix = fontWeight ? `${fontWeight} ` : "";
  let fontSize = baseFontSizePx;
  while (fontSize > minFontSizePx) {
    const candidate = `${prefix}${fontSize}px ${FONT_FAMILY_STACK}`;
    ctx.font = candidate;
    if (ctx.measureText(text).width <= maxWidthPx) {
      return candidate;
    }
    fontSize -= 1;
  }
  return `${prefix}${minFontSizePx}px ${FONT_FAMILY_STACK}`;
}

/** Standardized City Nameplate Typography (design note #50), REVISED by
 *  design note #51's "18xx-Style Text Background Shield Box". Shared by
 *  every name-label call site in `draw()` -- landmark names, gray/OO hex
 *  names, and the two independent halves of a split dual-city OO/
 *  double-town label -- so all of them read identically.
 *
 *  #50's own reversal of the OLDER "Muted Base Text with Hover Glow"
 *  styling (item 7) still stands on its main points: no glow/shadow, no
 *  translucent color, solid `#000000` text in both hover states -- see
 *  #50's own doc comment (this function's history, left in place) for that
 *  reasoning. #51 partially reverses ONE piece of it, though: #50 also
 *  removed the background box ENTIRELY (a bare `ctx.fillText`, nothing
 *  drawn behind it) -- #51 restores a box, but a functionally different one
 *  from the OLD pre-#50 pill: tight (2.5px padding, near this request's
 *  requested 2px-3px), genuinely RECTANGULAR (a near-zero `cornerRadiusPx`,
 *  not `drawLabelWithBackground`'s default soft rounding), ZERO stroke
 *  (`drawLabelWithBackground`'s box was always stroke-free to begin with --
 *  see that function's own body), and filled to nearly MATCH the
 *  surrounding hex rather than stand out as a floating dark plate -- see
 *  `boxFill` below. Purpose per the request: block a track spline from
 *  visually cutting through a letterform where it passes under the text,
 *  not to draw attention to the label as a UI element the way the OLD pill
 *  did.
 *
 *  `boxFill`: the caller-supplied color the box should ~match. Precise
 *  per-hex fill matching (reading back whatever `TERRAIN_FILL`/
 *  `PRINTED_HEX_FILL` entry actually painted that exact hex) was considered
 *  and rejected as unnecessary complexity for a purely functional occlusion
 *  box -- the request's own wording offers "match the hex background fill
 *  (OR soft pale yellow ... on yellow OO hexes)" as two acceptable
 *  alternatives, not one strict requirement. Call sites instead pass one of
 *  two constants below: `NAMEPLATE_BOX_FILL_YELLOW` for the two hex
 *  categories that are ACTUALLY printed yellow (landmarks, OO hexes --
 *  `PRINTED_HEX_FILL.Yellow`-filled per the "Unify All Board Yellow Shades"
 *  pass), `NAMEPLATE_BOX_FILL_DEFAULT` for every other nameplate (gray/
 *  named single-city hexes, double-town hexes), a warm cream close to this
 *  file's own `TERRAIN_FILL`/`BOARD_HEX_FILL.Plain` family so it reads as
 *  "part of the tile" rather than a mismatched patch.
 *
 *  `NAMEPLATE_FONT_SIZE_PX`/`NAMEPLATE_FONT_MIN_PX` (module-level constants,
 *  just below, UNCHANGED by #51): a genuinely narrow, near-fixed band --
 *  was base 10/min 6 at rest and base 13/min 7 on hover pre-#50, a swing of
 *  more than 2x end to end across this file's ~32 real city/town names.
 *  `fitFontSize` only ever actually shrinks below `NAMEPLATE_FONT_SIZE_PX`
 *  for the small handful of outlier long single-line names ("Washington,
 *  D.C.", "Atlantic City") -- every other name (now including every OO/
 *  double-town half, split onto its own line by the stacking passes below)
 *  renders at the exact same size. A truly zero-tolerance fixed size (no
 *  shrink band at all) was considered and rejected: those two outlier
 *  names would then visibly overflow their own hex's width at default
 *  zoom, which is a worse legibility defect than the (now much narrower)
 *  size band this keeps instead.
 *
 *  Weight (design note #51): ALWAYS bold now, matching the request's own
 *  "bold, high-contrast sans-serif" wording -- was bold-on-hover/
 *  normal-at-rest (#50). Hover no longer changes anything about this
 *  label's own rendering at all; the box/text are now identical in both
 *  states. `FONT_FAMILY_STACK` (design note #46, `system-ui, -apple-system,
 *  sans-serif`) is kept rather than swapped for the request's own literal
 *  `system-ui, sans-serif` example -- a strict superset fallback chain, not
 *  a deviation from it. */
// Design note #78: bumped 10/8 -> 11/9 as part of standardizing EVERY
// nameplate on the board (previously the off-board zone pass had its own
// independent 10/6 literals) onto one shared, crisp size band -- see that
// design note's own top-of-file entry for the full before/after.
// Design note #80: reported too large at 11/9 -- dropped 4pt to 7/5.
// Design note #81: 7pt tried next-smallest at 8/6, per direct feedback --
// same shared band, still applied uniformly board-wide (on-board and
// off-board nameplates alike, per #78/#79).
const NAMEPLATE_FONT_SIZE_PX = 8;
const NAMEPLATE_FONT_MIN_PX = 6;
/** Design note #51: `lineHeight = 1.05 * fontSize`, per the request's own
 *  explicit formula -- each stacked line offsets `NAMEPLATE_LINE_HEIGHT_PX
 *  / 2` above/below true center, so consecutive line centers sit exactly
 *  one `lineHeight` apart. Derived from `NAMEPLATE_FONT_SIZE_PX` (not
 *  `hexSize`, unlike the OLD `hexSize * 0.19`/`0.24` offsets it replaces)
 *  so the stack's own compactness tracks the now-fixed font size rather
 *  than the hex's zoom-dependent pixel size. */
const NAMEPLATE_LINE_HEIGHT_PX = NAMEPLATE_FONT_SIZE_PX * 1.05;
/** Design note #54 ("High-Contrast Light Shield Boxes"), REPLACING #51's
 *  two-constant scheme (`NAMEPLATE_BOX_FILL_YELLOW`/`_DEFAULT`) with a
 *  three-way, explicitly tier-matched set -- see `nameplateBoxFillFor`'s own
 *  doc comment for exactly which hex/tile state maps to which constant.
 *  `NAMEPLATE_BOX_FILL_YELLOW` (`#FEF08A`) is unchanged from #51. The other
 *  two are new: `NAMEPLATE_BOX_FILL_GREEN` (`#DCFCE7`, pale mint) for a laid
 *  Green tile, and `NAMEPLATE_BOX_FILL_SLATE` (`#F1F5F9`, light pale slate)
 *  for a laid Brown tile, a real GRAY preprinted hex, or any other ordinary
 *  hex -- retiring the old flat cream `NAMEPLATE_BOX_FILL_DEFAULT`
 *  (`#f4ecd8`) that used to cover all three of those cases identically. */
const NAMEPLATE_BOX_FILL_YELLOW = "#FEF08A";
const NAMEPLATE_BOX_FILL_GREEN = "#DCFCE7";
const NAMEPLATE_BOX_FILL_SLATE = "#F1F5F9";
/** Design note #78: REPLACES the tier-color-matched `NAMEPLATE_BOX_FILL_*`
 *  scheme above (still defined, just no longer wired into `drawHexNameLabel`)
 *  with one flat semi-transparent white shield for every nameplate on the
 *  board, on-board and off-board alike -- so a track spline underneath
 *  stays softly visible through the box at rest, and the box (not the
 *  underlying tile color) is what changes on hover, going fully opaque so a
 *  hovered name is unambiguously the most readable element on that hex.
 *  Design note #82: opacity dropped 0.75 -> 0.55 (20 points more
 *  transparent), per direct request -- hover still goes fully opaque
 *  (`_HOVERED`, unchanged), so the at-rest/hover contrast is now wider. */
const NAMEPLATE_SHIELD_FILL = "rgba(255, 255, 255, 0.55)";
const NAMEPLATE_SHIELD_FILL_HOVERED = "rgba(255, 255, 255, 1.0)";

/** Design note #54: resolves the tier-matched shield-box fill for the
 *  nameplate at `(q, r)` -- a laid tile's REAL current color when one
 *  exists (via `TILE_CATALOG_BY_ID`, the same lookup the laid-tile fill/
 *  stroke pass above uses), or the hex's own static printed category
 *  (`STATIC_BOARD_HEXES.printedColor`) when nothing has been laid there
 *  yet. Yellow tile / printed-Yellow hex (landmarks, OO hexes before their
 *  own first lay) -> `NAMEPLATE_BOX_FILL_YELLOW`; Green tile ->
 *  `NAMEPLATE_BOX_FILL_GREEN`; Brown tile, a real GRAY preprinted hex
 *  (`printedColor: "Gray"`), or any other ordinary hex with no printed
 *  color at all (a bare white city/town-designated hex) ->
 *  `NAMEPLATE_BOX_FILL_SLATE` -- the request's own "Brown / Gray /
 *  Off-Board Hexes" grouping. Every existing `drawHexNameLabel` call site
 *  is still gated by `hexHasLaidTile`'s Dynamic City Nameplate Suppression
 *  (design note #47), so the laid-tile branch below is not reachable
 *  through any of today's four call sites -- kept fully wired anyway (a
 *  real lookup, not a stub) so this helper is complete and correct on its
 *  own terms rather than silently dropping the Green case. */
function nameplateBoxFillFor(mapGrid: MapGridResponse, q: number, r: number): string {
  const laidTile = mapGrid.tiles.find((tile) => tile.q === q && tile.r === r);
  if (laidTile) {
    const catalogEntry = TILE_CATALOG_BY_ID.get(laidTile.tile_id);
    if (catalogEntry?.color === "Yellow") return NAMEPLATE_BOX_FILL_YELLOW;
    if (catalogEntry?.color === "Green") return NAMEPLATE_BOX_FILL_GREEN;
    return NAMEPLATE_BOX_FILL_SLATE; // Brown, or an unrecognized catalog entry
  }
  const boardHex = STATIC_BOARD_HEXES.find((hex) => hex.q === q && hex.r === r);
  if (boardHex?.printedColor === "Yellow") return NAMEPLATE_BOX_FILL_YELLOW;
  return NAMEPLATE_BOX_FILL_SLATE; // real GRAY hexes, and ordinary unprinted white hexes alike
}

function drawHexNameLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  point: { x: number; y: number },
  maxWidthPx: number,
  isHovered: boolean,
): void {
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // Design note #78: REGULAR weight now (was always `"bold"` since #51) --
  // `isHovered` still doesn't affect sizing/weight, only which shield-box
  // fill is used just below.
  ctx.font = fitFontSize(ctx, text, NAMEPLATE_FONT_SIZE_PX, maxWidthPx, NAMEPLATE_FONT_MIN_PX, "");
  // Design note #78: flat semi-transparent white shield at rest, fully
  // opaque on hover (REPLACING #54's tier-color-matched `boxFill` param) --
  // tight (2px padding, 2px corner radius, genuinely rectangular, never
  // stroked) box shape unchanged from #54/#51. Solid `#000000` text,
  // unchanged.
  ctx.fillStyle = "#000000";
  drawLabelWithBackground(ctx, text, point, {
    paddingX: 2,
    paddingY: 2,
    fillStyle: isHovered ? NAMEPLATE_SHIELD_FILL_HOVERED : NAMEPLATE_SHIELD_FILL,
    cornerRadiusPx: 2,
  });
  ctx.restore();
}

/** Design note #84: draws a two-line "A" over "B" nameplate (every #83
 *  ampersand/"Maritime Provinces" wrap case) with ONE shared background
 *  shield spanning BOTH lines, instead of each line independently calling
 *  `drawHexNameLabel` and painting its own box. Reported: two of #82's
 *  0.55-alpha boxes, stacked directly above/below each other with only
 *  `NAMEPLATE_LINE_HEIGHT_PX` between their centers, overlapped in the
 *  shared band between the two lines -- alpha compositing then made that
 *  overlapped strip visibly darker than the rest of the shield, a seam
 *  right where the two lines meet. Unioning both lines' padded boxes into
 *  ONE rect, filled once via `fillRoundedRect`, removes the seam entirely
 *  regardless of the two lines' relative widths. Both lines also render at
 *  one SHARED font size -- the smaller of each line's own independent
 *  `fitFontSize` result -- so a length mismatch between the two words
 *  can't produce a visible size mismatch either. `center` is the same
 *  point every existing two-line call site already computed as the
 *  midpoint between its two lines (`center.y -/+ NAMEPLATE_LINE_HEIGHT_PX
 *  / 2`) -- this function derives that same split internally, so callers
 *  just pass the shared center they already had. */
function drawStackedNameLabel(
  ctx: CanvasRenderingContext2D,
  lines: readonly [string, string],
  center: { x: number; y: number },
  maxWidthPx: number,
  isHovered: boolean,
): void {
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const font0 = fitFontSize(ctx, lines[0], NAMEPLATE_FONT_SIZE_PX, maxWidthPx, NAMEPLATE_FONT_MIN_PX, "");
  const size0 = parseInt(font0, 10) || NAMEPLATE_FONT_MIN_PX;
  const font1 = fitFontSize(ctx, lines[1], NAMEPLATE_FONT_SIZE_PX, maxWidthPx, NAMEPLATE_FONT_MIN_PX, "");
  const size1 = parseInt(font1, 10) || NAMEPLATE_FONT_MIN_PX;
  const sharedSize = Math.min(size0, size1);
  ctx.font = `${sharedSize}px ${FONT_FAMILY_STACK}`;

  const lineOffset = NAMEPLATE_LINE_HEIGHT_PX / 2;
  const point0 = { x: center.x, y: center.y - lineOffset };
  const point1 = { x: center.x, y: center.y + lineOffset };

  const metrics0 = ctx.measureText(lines[0]);
  const metrics1 = ctx.measureText(lines[1]);
  const ascent0 = metrics0.actualBoundingBoxAscent ?? sharedSize * 0.75;
  const descent1 = metrics1.actualBoundingBoxDescent ?? sharedSize * 0.25;

  const paddingX = 2;
  const paddingY = 2;
  const boxWidth = Math.max(metrics0.width, metrics1.width) + paddingX * 2;
  const boxTop = point0.y - ascent0 - paddingY;
  const boxBottom = point1.y + descent1 + paddingY;
  const boxHeight = boxBottom - boxTop;
  const boxX = center.x - boxWidth / 2;
  const radius = Math.min(2, boxHeight / 2, boxWidth / 2);

  fillRoundedRect(
    ctx,
    boxX,
    boxTop,
    boxWidth,
    boxHeight,
    radius,
    isHovered ? NAMEPLATE_SHIELD_FILL_HOVERED : NAMEPLATE_SHIELD_FILL,
  );

  ctx.fillStyle = "#000000";
  ctx.fillText(lines[0], point0.x, point0.y);
  ctx.fillText(lines[1], point1.x, point1.y);
  ctx.restore();
}

/** Design note #79: draws a single-node hex's nameplate at `anchor`, with a
 *  much more generous `maxLineWidthPx` (from the call site, matching the
 *  off-board pass's own `hexFlatWidth * 0.92`, up from #78's tight `0.55`)
 *  so long single-line names (Atlantic City, Fall River, Washington, D.C.,
 *  Providence, Rochester, Kingston, Cleveland, Columbus, Lancaster,
 *  Baltimore) no longer need to shrink via `fitFontSize` the way they did
 *  under #78's tighter budget -- exactly the "different font size from the
 *  other nameplates" bug #78 was supposed to eliminate but didn't. The
 *  hex's own clip mask (`withHexClip`, #53) is the real safety net for any
 *  name that somehow still doesn't fit.
 *
 *  Design note #83 REMOVES this function's own #79-era "wrap a multi-word
 *  name at its first space" behavior: per explicit rule, a single-node
 *  hex's nameplate NEVER wraps (none of the single-node names -- gray/
 *  named hexes, Boston, Baltimore -- contain an ampersand, and none of
 *  them is the one named exception, Maritime Provinces, which is an
 *  off-board zone handled by `drawOffboardNameplate` instead). Kept as a
 *  thin, explicitly-named wrapper (rather than inlining `drawHexNameLabel`
 *  at both call sites) so a future single-node exception, if one is ever
 *  added, has one obvious place to go. */
function drawSingleNodeNameplate(
  ctx: CanvasRenderingContext2D,
  name: string,
  anchor: { x: number; y: number },
  maxLineWidthPx: number,
  isHovered: boolean,
): void {
  drawHexNameLabel(ctx, name, anchor, maxLineWidthPx, isHovered);
}

/** Design note #83: the board-wide nameplate-wrap rule -- a nameplate
 *  breaks onto two stacked lines ONLY when it names two separate cities
 *  via an ampersand ("A & B" -- the OO/double-town/landmark-DoubleCity
 *  passes' own existing `.split(" & ")` calls already implement this), with
 *  ONE named exception: "Maritime Provinces", too long for its single hex
 *  on one line despite naming only one place. Every OTHER off-board zone
 *  name ("Chicago", "Gulf", "Canadian West", "Deep South") stays a single
 *  line now, reversing #47's old "every multi-word name wraps" default. */
function offboardNameplateLines(offboardName: string): readonly string[] {
  if (offboardName === "Maritime Provinces") {
    const spaceIndex = offboardName.indexOf(" ");
    return [offboardName.slice(0, spaceIndex), offboardName.slice(spaceIndex + 1)];
  }
  return [offboardName];
}

/** Floating "canvas tooltip card" showing an off-board zone's full
 *  Yellow -> Green -> Brown revenue progression -- see design note #15/
 *  item 4. Drawn in the SAME world-space transform as everything else in
 *  `draw()` (so it pans/zooms with the board exactly like every other
 *  on-canvas label here, matching this file's existing convention rather
 *  than adding a second, screen-space-fixed overlay system), anchored just
 *  outside the hovered hex's own center so the card never covers the hex
 *  it's describing. Each row gets a small color-coded dot matching
 *  `COLOR_TIER_STROKE`, and the row matching `currentEra` is bolded/in white
 *  (a separate green "ACTIVE" label used to repeat that same emphasis a
 *  second time and was removed per feedback -- the bold/white treatment
 *  alone is enough) -- the same value already rendered directly inside the
 *  hex (see the off-board label pass in `draw()`), shown here alongside
 *  its Yellow/Green/Brown context.
 *
 *  ADAPTIVE QUADRANT (follow-up to design note #15/item 4): a fixed
 *  "always above-right" anchor used to clip off the visible canvas for
 *  off-board zones that sit near the board's top or right edge --
 *  Canadian West (top-center) and Maritime Provinces (top-right) both had
 *  no room above/right of their hex for the card to render into, so it
 *  rendered off-frame and was never visible. `preferLeft`/`preferBelow`
 *  (computed by the caller from the hovered hex's position relative to
 *  the board's own center, via `boardContentBounds`) flip the card to
 *  whichever side of the hex actually points back toward the board's
 *  interior, so it always has room. This is deliberately NOT a blanket
 *  "always below-left" flip: Gulf (bottom-left) and Deep South
 *  (bottom-center) already render correctly with the original above-right
 *  anchor precisely because they sit in the opposite corner from Canadian
 *  West/Maritime -- forcing them to below-left too would just move the
 *  clipping problem to the bottom edge instead of fixing it. */
function drawOffboardTooltip(
  ctx: CanvasRenderingContext2D,
  anchor: { x: number; y: number },
  hexSize: number,
  zoneName: string,
  tiers: OffboardRevenueTiers,
  currentEra: TileColorTier,
  preferLeft: boolean,
  preferBelow: boolean,
): void {
  // Green shares the Yellow-printed figure -- see `offboardValueForEra`'s
  // own doc comment for why there's no distinct third number.
  const rows: ReadonlyArray<{ label: TileColorTier; value: number }> = [
    { label: "Yellow", value: tiers.yellow },
    { label: "Green", value: tiers.yellow },
    { label: "Brown", value: tiers.brown },
  ];

  const paddingX = 10;
  const paddingY = 8;
  const rowHeight = 16;
  const titleFont = "bold 12px sans-serif";
  const rowFont = "11px sans-serif";

  ctx.font = titleFont;
  const titleWidth = ctx.measureText(zoneName).width;
  ctx.font = rowFont;
  let maxRowWidth = 0;
  for (const row of rows) {
    maxRowWidth = Math.max(maxRowWidth, ctx.measureText(`${row.label}: $${row.value}`).width + 16);
  }
  const cardWidth = Math.max(titleWidth, maxRowWidth) + paddingX * 2;
  const cardHeight = paddingY * 2 + 18 + rows.length * rowHeight;

  const cardX = preferLeft ? anchor.x - hexSize * 0.7 - cardWidth : anchor.x + hexSize * 0.7;
  const cardY = preferBelow ? anchor.y + hexSize * 0.9 : anchor.y - hexSize * 0.9 - cardHeight;

  ctx.save();
  ctx.fillStyle = "rgba(18, 20, 26, 0.94)";
  ctx.strokeStyle = "#3a3f4b";
  ctx.lineWidth = 1.5;
  const radius = 8;
  ctx.beginPath();
  ctx.moveTo(cardX + radius, cardY);
  ctx.arcTo(cardX + cardWidth, cardY, cardX + cardWidth, cardY + cardHeight, radius);
  ctx.arcTo(cardX + cardWidth, cardY + cardHeight, cardX, cardY + cardHeight, radius);
  ctx.arcTo(cardX, cardY + cardHeight, cardX, cardY, radius);
  ctx.arcTo(cardX, cardY, cardX + cardWidth, cardY, radius);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "#f4ecd8";
  ctx.font = titleFont;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(zoneName, cardX + paddingX, cardY + paddingY);

  let rowY = cardY + paddingY + 18;
  for (const row of rows) {
    const isActive = row.label === currentEra;

    ctx.fillStyle = COLOR_TIER_STROKE[row.label];
    ctx.beginPath();
    ctx.arc(cardX + paddingX + 4, rowY + rowHeight / 2, 4, 0, Math.PI * 2);
    ctx.fill();

    // The bold/white treatment above already marks the active era on its
    // own; the separate green "ACTIVE" label used to repeat that same
    // information a second time, so it's been removed per feedback.
    ctx.fillStyle = isActive ? "#ffffff" : "#b8bcc4";
    ctx.font = isActive ? "bold 11px sans-serif" : rowFont;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(`${row.label}: $${row.value}`, cardX + paddingX + 14, rowY + rowHeight / 2);

    rowY += rowHeight;
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* Board margin labels -- see design note #16                         */
/* ------------------------------------------------------------------ */

/** Parses the real printed column number out of a board hex's own `label`
 *  (e.g. `"G19"` -> `19`) -- see design note #16. */
function parseColumnNumber(label: string): number | null {
  const match = /^[A-Z]+(\d+)$/.exec(label);
  return match ? Number(match[1]) : null;
}

/** Real board row letters, one per axial row index `r` -- row A (`r = 0`)
 *  through row K (`r = 10`), matching every real hex `label` in
 *  `STATIC_BOARD_HEXES` exactly (see design note #6's row-letter/column-
 *  number -> axial transform, which this is the direct inverse of for the
 *  row half). */
function rowLetterForR(r: number): string {
  return String.fromCharCode(65 + r);
}

/** Computes where to stamp each row's letter (left/right margins) and each
 *  column's number (top/bottom margins) -- see design note #16. Built
 *  directly off the real `STATIC_BOARD_HEXES` data (not a generated
 *  rectangle): a label only ever appears for a real row/column of the
 *  authentic 93-hex board. Per design note #1's pointy-top axial geometry,
 *  a fixed axial row `r` always shares one pixel `y` regardless of `q`, and
 *  a fixed real column number always shares one pixel `x` regardless of
 *  which row it's read from (`x = hexSize * sqrt(3) * (columnNumber - 1) /
 *  2`, independent of `r`, by substituting `q = (columnNumber - 1 - r) / 2`
 *  into `axialToPixel`) -- which is exactly why the physical board's
 *  rows/columns print as straight horizontal/vertical lines in the first
 *  place. This function re-derives both purely from `axialToPixel` itself
 *  (not that hand-expanded formula), so it can never drift out of sync with
 *  design note #1's own conversion.
 *
 *  CROSS-AXIS POSITIONING (design note #25 -- restores what design note #24
 *  had temporarily dropped): this function computes BOTH axes again -- each
 *  row's `y` / column's `x` (the axis that has to line up with actual hex
 *  rows/columns) AND each row's `leftX`/`rightX` / column's `topY`/`bottomY`
 *  (how far out from the board's own real extent the label floats,
 *  STRAIGHTENED to one shared value per side -- see below). Design note #24
 *  briefly dropped the latter when labels were a DOM overlay pinned to the
 *  canvas's own literal pixel edges; now that labels are drawn NATIVELY on
 *  the canvas instead (design note #25), that DOM-edge anchor no longer
 *  exists, so the cross-axis position has to come from real board geometry
 *  again, exactly like it did before design note #20.
 *
 *  STRAIGHTENED margins (design note #16/#17): every row's left-margin
 *  label used to sit at that row's OWN real leftmost hex -- correct
 *  per-row, but visually staircased/jagged overall, since the board's
 *  ragged ends (e.g. row A only spans columns 9-19, no column-3 hex) put
 *  each row's real leftmost hex at a different x. `leftX`/`rightX` are ONE
 *  shared value for every row -- the min/max across the ENTIRE board, not
 *  just that row -- so every row-letter label lines up on a single straight
 *  vertical line at each margin, matching how a real printed board's
 *  row-letter gutter is one straight column of text, not a jagged one.
 *  `topY`/`bottomY` are straightened the identical way across every
 *  column. */
function computeBoardMarginLabels(
  ctx: CanvasRenderingContext2D,
  hexSize: number,
  fontSize: number,
): {
  rows: Array<{ letter: string; y: number; leftX: number; rightX: number }>;
  columns: Array<{ columnNumber: number; x: number; topY: number; bottomY: number }>;
} {
  const rowY = new Map<number, number>();
  const colX = new Map<number, number>();
  let boardMinX = Infinity;
  let boardMaxX = -Infinity;
  let boardMinY = Infinity;
  let boardMaxY = -Infinity;

  for (const hex of STATIC_BOARD_HEXES) {
    const { x, y } = axialToPixel(hex.q, hex.r, hexSize);
    boardMinX = Math.min(boardMinX, x);
    boardMaxX = Math.max(boardMaxX, x);
    boardMinY = Math.min(boardMinY, y);
    boardMaxY = Math.max(boardMaxY, y);

    if (!rowY.has(hex.r)) rowY.set(hex.r, y);

    const columnNumber = parseColumnNumber(hex.label);
    if (columnNumber === null) continue;
    if (!colX.has(columnNumber)) colX.set(columnNumber, x);
  }

  // ITEM 2 FIX (this pass, "Inset Canvas Drawing for Margins" -- see design
  // note #28). The structural calibration pass's `hexSize * 0.93` inset
  // only ever cleared the OUTERMOST HEX's own silhouette against the
  // camera's `hexEdgePadding = hexSize` visible boundary -- it never
  // accounted for a drawn label's own rendered box (this label's text plus
  // `drawLabelWithBackground`'s own background padding) extending further
  // still, past that anchor point, in the direction the label reads. A
  // 2-character column number, or the background box's own padding, could
  // each eat into -- and exceed -- the old inset's remaining ~0.07 *
  // hexSize of clearance, silently slicing the label exactly as this item
  // reports. This measures the actual widest row-letter and column-number
  // label this board will ever draw, using the SAME font
  // `drawBoardMarginLabels` sets on `ctx` before calling this (a real
  // rendered size, not a guessed constant), and folds that half-extent plus
  // the background padding into a single safety offset applied to every
  // margin, so each label's own drawn box -- not just its anchor point --
  // stays inside the camera's visible boundary.
  // must match `boardContentBounds`'s own camera-fit padding exactly (see
  // its "Camera Padding Must Reserve Room For Margin Labels" comment) --
  // both derive the SAME `hexSize + marginLabelReserve(hexSize)` total, or
  // this function's labels end up placed outside the camera's actual
  // visible boundary (clipped) or inside it with less room than the camera
  // reserved (back to overlapping the outermost hex).
  const hexEdgePadding = hexSize + marginLabelReserve(hexSize);
  const rowLetterStrings = Array.from(rowY.keys()).map(rowLetterForR);
  const columnNumberStrings = Array.from(colX.keys()).map(String);
  // ITEM (this pass, "Vertical Margin Label Clearance"): row letters sit to
  // the LEFT/RIGHT of the board, so the dimension that determines whether
  // their drawn box clears the outermost hex is the label's WIDTH (how far
  // it extends back toward the board horizontally). Column numbers sit
  // ABOVE/BELOW the board, so the dimension that matters for THEM is the
  // label's HEIGHT (how far it extends back toward the board vertically) --
  // a different quantity, not interchangeable with width. The previous
  // version measured only `.width` for every label (row letters AND column
  // numbers combined) and reused that single value for both the horizontal
  // AND vertical safety offsets. That happened to work for the row letters
  // (width is exactly what they need) but understated the true clearance
  // column numbers need whenever a label's rendered height exceeds its
  // rendered width (typical for digit glyphs), letting the top/bottom
  // column-number row sit on top of the outermost hexes -- exactly the
  // reported bug ("top and bottom rows... does not encroach on the side").
  const rowLabelWidth = rowLetterStrings.reduce(
    (max, label) => Math.max(max, ctx.measureText(label).width),
    0,
  );
  const columnLabelMetrics = columnNumberStrings.map((label) => ctx.measureText(label));
  // `actualBoundingBoxAscent`/`actualBoundingBoxDescent` give the label's
  // real rendered extent above/below the anchor point, relative to
  // `drawBoardMarginLabels`'s `ctx.textBaseline = "middle"` -- the correct
  // vertical analogue of `.width`. Some canvas backends don't populate
  // these (older engines, some headless polyfills), so fall back to
  // `fontSize` (a reasonable glyph-height estimate) when either is missing
  // or non-finite.
  const columnLabelHeight = columnLabelMetrics.reduce((max, metrics) => {
    const ascent = metrics.actualBoundingBoxAscent;
    const descent = metrics.actualBoundingBoxDescent;
    const height =
      Number.isFinite(ascent) && Number.isFinite(descent) ? ascent + descent : fontSize;
    return Math.max(max, height);
  }, 0);
  // `drawLabelWithBackground`'s own default `paddingX` -- the larger of its
  // two default paddings, used here as a single conservative margin.
  // Aliased from the shared module-level constant (see its doc comment) so
  // this can never silently drift out of sync with `boardContentBounds`'s
  // own `marginLabelReserve` budget, which is built from the same value.
  const BACKGROUND_PADDING_PX = MARGIN_LABEL_BACKGROUND_PADDING_PX;
  // Design note #36/item 2 ("Inset Margin Label Drawings"): an EXTRA
  // clearance budget on top of `BACKGROUND_PADDING_PX` above. Before this,
  // the safety offset placed a label's rendered edge only
  // `BACKGROUND_PADDING_PX` (4 world-space units) inside the camera's own
  // exact visible boundary (`boardContentBounds`'s `hexEdgePadding`) --
  // razor-thin, and at typical zoom levels that's only a handful of real
  // screen pixels of clearance, easily read as "sliced off by the pane
  // borders" from any small additional discrepancy (canvas backing-store
  // rounding, a scrollbar narrowing the measured width after the last
  // `ResizeObserver` tick, etc.) -- exactly this item's complaint. This
  // constant does NOT touch `hexEdgePadding`/`boardContentBounds` itself
  // (design note #26 deliberately kept that a tight, non-padded fit, per an
  // earlier item's own "remove any large hardcoded pixel padding"
  // instruction) -- it just claims a bit more of that SAME existing budget
  // for the label specifically, pulling the label further in from the
  // exact edge without reintroducing extra camera padding around the board.
  // Aliased from the shared module-level constant (see its doc comment) for
  // the same reason as `BACKGROUND_PADDING_PX` above.
  const EXTRA_MARGIN_INSET_PX = MARGIN_LABEL_EXTRA_INSET_PX;
  // VERIFICATION PASS (this pass, item 2): uses the SAME `fontSize` value
  // `drawBoardMarginLabels` actually draws with (`Math.max(11, hexSize *
  // 0.3)`, floored at 11px), not a re-derived `hexSize * 0.3` missing that
  // floor -- at a small enough `hexSize` the floor dominates, and the
  // un-floored version would have understated the label's real rendered
  // (and therefore its real half-extent) size.
  //
  // Two independent half-extents now, one per axis (see the width-vs-height
  // comment above `rowLabelWidth`): the X half-extent (from row-letter
  // WIDTH) governs the left/right offset, and the Y half-extent (from
  // column-number HEIGHT) governs the top/bottom offset. Each is still
  // floored at `fontSize / 2` as a conservative minimum, matching the prior
  // behavior's floor.
  const maxLabelHalfExtentX = Math.max(rowLabelWidth, fontSize) / 2;
  const maxLabelHalfExtentY = Math.max(columnLabelHeight, fontSize) / 2;
  const labelSafetyOffsetX = Math.max(
    0,
    hexEdgePadding - (maxLabelHalfExtentX + BACKGROUND_PADDING_PX + EXTRA_MARGIN_INSET_PX),
  );
  const labelSafetyOffsetY = Math.max(
    0,
    hexEdgePadding - (maxLabelHalfExtentY + BACKGROUND_PADDING_PX + EXTRA_MARGIN_INSET_PX),
  );
  const leftX = boardMinX - labelSafetyOffsetX;
  const rightX = boardMaxX + labelSafetyOffsetX;
  const topY = boardMinY - labelSafetyOffsetY;
  const bottomY = boardMaxY + labelSafetyOffsetY;

  const rows = Array.from(rowY.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([r, y]) => ({
      letter: rowLetterForR(r),
      y,
      leftX,
      rightX,
    }));
  const columns = Array.from(colX.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([columnNumber, x]) => ({
      columnNumber,
      x,
      topY,
      bottomY,
    }));

  return { rows, columns };
}

/** Row-letter (A-K) / column-number (1-24) board margin labels -- drawn
 *  NATIVELY inside the canvas via `ctx.fillText` (design note #25; corrects
 *  design note #20's DOM-overlay detour). Called from `draw()` INSIDE that
 *  function's own `ctx.translate(view.panX, view.panY)` /
 *  `ctx.scale(view.zoom, view.zoom)` world-space transform (the exact same
 *  transform every hex/track/other label in this file already draws
 *  through) -- so these labels automatically pan, zoom, scale, and stay
 *  aligned with their corresponding hex rows/columns in real time, using
 *  the live `view` (not a locked baseline), simply because they're drawn
 *  through the same pixel math as everything else on the board. No separate
 *  screen-space projection, DOM position, or "tracking" computation of any
 *  kind is needed -- alignment falls out of using one shared coordinate
 *  transform for the whole canvas. Drawn LAST in `draw()`'s world-space
 *  pass (matching design note #16's original ordering), through the same
 *  safe-contrast `drawLabelWithBackground` convention as every other label
 *  in this file. */
function drawBoardMarginLabels(ctx: CanvasRenderingContext2D, hexSize: number): void {
  // Shared with `marginLabelReserve` (see its doc comment) so the camera's
  // reserved padding and the font actually drawn here can never drift out
  // of sync.
  const fontSize = marginLabelFontSize(hexSize);
  // Set BEFORE calling `computeBoardMarginLabels` (design note #28/item 2):
  // it measures label widths via `ctx.measureText`, which needs this exact
  // font already applied to `ctx` to return an accurate size.
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // Design note #30/item 2: was `#1a2e1f`, a dark green chosen back when
  // this text always sat on `drawLabelWithBackground`'s own translucent
  // WHITE box (`rgba(255, 255, 255, 0.72)`) -- against that light box, a
  // dark ink color was the correct, legible choice. These labels sit
  // outside the board's hex footprint, over this component's own solid
  // dark-charcoal workspace fill (`#141414`, design note #18); now that the
  // box is removed below (`background: false`) so the letters/numbers float
  // directly on that charcoal, `#1a2e1f`-on-`#141414` would be almost
  // unreadable (dark-on-near-black, no contrast at all) -- the exact
  // opposite of legible. Switched to a bright off-white so the labels stay
  // clearly readable with nothing behind them, matching the light-on-dark
  // convention this file already uses elsewhere for text over dark fills
  // (e.g. the off-board nameplate's `#ffe0e0`).
  ctx.fillStyle = "#f0f0f0";

  const { rows, columns } = computeBoardMarginLabels(ctx, hexSize, fontSize);

  // Design note #30/item 2 ("Transparent Coordinate Margin Fills"):
  // `background: false` skips `drawLabelWithBackground`'s rounded-rect
  // contrast box entirely -- these are the ONLY labels in this file drawn
  // that way; every other label (city/landmark names, cost labels,
  // off-board nameplates, era-tier cards) keeps its box per design note
  // #6c, since those sit over varied/busy hex fills and track strokes where
  // a contrast box still earns its keep. The margin band sits over one
  // uniform solid color (the charcoal workspace fill), so a background box
  // there was only ever adding an "ugly block outline frame" with no
  // legibility benefit -- the brightened text color above supplies the
  // needed contrast on its own.
  // Rail Map Overhaul (design note #42): these labels have no background
  // box at all (`background: false`, above) -- `strokeHalo: true` gives them
  // their own dark outline instead, so they stay crisp at any zoom level
  // over whatever happens to sit behind them (charcoal workspace fill, or a
  // hex fill/track once panned close to the board edge).
  for (const row of rows) {
    drawLabelWithBackground(ctx, row.letter, { x: row.leftX, y: row.y }, { background: false, strokeHalo: true });
    drawLabelWithBackground(ctx, row.letter, { x: row.rightX, y: row.y }, { background: false, strokeHalo: true });
  }
  for (const column of columns) {
    const label = String(column.columnNumber);
    drawLabelWithBackground(ctx, label, { x: column.x, y: column.topY }, { background: false, strokeHalo: true });
    drawLabelWithBackground(ctx, label, { x: column.x, y: column.bottomY }, { background: false, strokeHalo: true });
  }
}

/* ------------------------------------------------------------------ */
/* Tile preview thumbnail -- for TileSelectionPopup.tsx (design note #7) */
/* ------------------------------------------------------------------ */

export interface TilePreviewThumbnailProps {
  tileId: number;
  /** Legal orientation angle (0-5) to preview -- see design note #7's
   *  orientation-cycling limitation. Default 0 (the lowest legal
   *  orientation, which is also always what the contract itself will
   *  auto-pick for a given `tile_id`). */
  orientation?: number;
  /** Overall canvas size in CSS pixels (square). Default 96. */
  size?: number;
  /** Hex radius used to render the tile within the canvas. Default 40. */
  hexSize?: number;
  className?: string;
}

/** A small, self-contained canvas that renders exactly one catalog tile in
 *  isolation -- terrain fill, color-tier outline, and its decoded track
 *  path at the given `orientation` -- reusing this file's own
 *  `TILE_CATALOG_BY_ID`/`drawHexPath`/`drawTrackPath` rather than a second
 *  hand-kept catalog mirror (see design note #2's "DESIGN GAP" discipline).
 *  Built for `TileSelectionPopup.tsx`'s carousel thumbnails and its larger
 *  rotation preview; has no wallet/session/query dependency of its own,
 *  matching this file's presentational-only design. */
export function TilePreviewThumbnail({
  tileId,
  orientation = 0,
  size = 96,
  hexSize = 40,
  className,
}: TilePreviewThumbnailProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    const center = { x: size / 2, y: size / 2 };
    const catalogEntry = TILE_CATALOG_BY_ID.get(tileId);

    drawHexPath(ctx, center, hexSize);
    ctx.fillStyle = catalogEntry ? ERA_TILE_FILL[catalogEntry.color] : "#dddddd";
    ctx.fill();
    ctx.strokeStyle = catalogEntry ? COLOR_TIER_STROKE[catalogEntry.color] : "#9a9a9a";
    ctx.lineWidth = 2;
    ctx.stroke();

    if (catalogEntry) {
      // Rail Map Overhaul (design note #42): Hex Boundary Clipping Mask.
      withHexClip(ctx, center, hexSize, () => {
        // Mirror-only, by construction (design note #119): this component
        // renders an UN-LAID tile in the picker carousel and has no query
        // row for it -- see this file's `pathsForTile`. It is also the
        // reason the mirror carries `paths` at all rather than the backend
        // being the single source: a tile has to render correctly before it
        // exists on the board.
        drawTrackPath(ctx, center, hexSize, catalogEntry, orientation);
      });
    } else {
      // Unknown tile_id -- see design notes #2/#118 -- same generic
      // provisional artwork as the main board renderer, rather than
      // silently drawing nothing. This path matters more here than on the
      // board: `TileSelectionPopup`'s carousel renders one of these per
      // legal placement the contract returned, so an id this mirror hasn't
      // caught up to is still a real, clickable, submittable choice and
      // needs to at least show its own number.
      withHexClip(ctx, center, hexSize, () => {
        drawUnknownTilePlaceholder(ctx, center, hexSize, tileId);
      });
    }

    ctx.restore();
  }, [tileId, orientation, size, hexSize]);

  return <canvas ref={canvasRef} style={{ width: size, height: size }} className={className} />;
}

export default HexGridRenderer;
