// frontend/src/components/StockMarketRenderer.tsx
//
// Renders `QueryMsg::GetMarketGrid`'s response (see `src/msg.rs`'s
// `MarketGridResponse`/`MarketPositionEntry`) as the 1830-style stock price
// matrix: a dark-mode grid keyed by `market::MARKET_MIN_X..=MAX_X` x
// `market::MARKET_MIN_Y..=MAX_Y` (19 columns x 11 rows -- the BACKEND's own
// coordinate contract, now real-board-accurate, see design note #1), with
// every trading corporation's ticker plotted at its live `(x, y)` position --
// staggered when more than one corporation shares a cell.
//
// Sibling to HexGridRenderer.tsx -- see that file for the hex map. The two
// are composed together inside App.tsx's tabbed board view.
//
// Design notes:
// 1. **Definitive architectural refactor -- authentic 1830 pricing mask,
//    not a formula mirror.** A prior pass deliberately kept this component's
//    prices on the backend's old `100 + x*10 + y*20` formula, specifically
//    to avoid disagreeing with what the chain actually stored (see that
//    pass's now-superseded design note #3, preserved in git history). That
//    constraint no longer applies: `market.rs`'s `MARKET_GRID` was migrated
//    in this same refactor to store the REAL, verbatim 1830 board data
//    (`market::REAL_MARKET_ROWS`) instead of a formula-computed placeholder,
//    so this component's `REAL_MARKET_ROWS` below is a byte-for-byte mirror
//    of that Rust constant -- both sides now render the exact same sourced
//    data, not merely "the same formula." Sourcing: the open-source
//    18xx.games engine's `lib/engine/game/g_1830/game.rb` `MARKET` constant
//    and `lib/engine/share_price.rb`'s `SharePrice::TYPE_MAP` zone-letter
//    legend (github.com/tobymao/18xx, fetched and cross-checked byte-for-byte
//    across two independent mirrors). No basic rectangular x/y loop drives
//    cell generation any more -- `buildPriceGrid` below walks this hardcoded
//    2D coordinate array directly, cell by cell, matching the physical
//    board's real jagged/cliffside column counts per row exactly (19 columns
//    at the top, narrowing to 4 at the very bottom).
// 2. **DOM/CSS grid, not canvas.** HexGridRenderer draws to a `<canvas>`
//    because a pannable/zoomable hex map benefits from that. This matrix is
//    a dense table of small text labels (prices, tickers) with no
//    pan/zoom/rotation requirement, so a CSS grid of real DOM nodes is the
//    simpler, more legible, and more accessible choice here -- text stays
//    crisp at any zoom level and ticker badges are ordinary elements, not
//    hand-drawn glyphs.
// 3. **Rule zone color fills.** Every real cell now carries a `zoneType`
//    (`Yellow` | `Orange` | `Brown` | `Normal`), mirroring `state.rs`'s
//    `ZoneType` enum and `market.rs`'s `REAL_MARKET_ROWS` exactly -- same
//    per-cell assignments, same explicit note that this project treats the
//    zones as CUMULATIVE (Orange implies the Yellow hand-limit exemption on
//    top of the ownership-cap waiver; Brown implies both Orange rules plus
//    multiple bank-pool buys), which is this project's own documented rule
//    interpretation matching the standard physical-board rulebook reading,
//    not a literal transcription of the source engine's single-letter
//    per-cell tag (verbatim source note: real `b`-tagged cells are never
//    also tagged `o` in the fetched array). Each zone gets a distinct
//    background tint plus a `title` tooltip using the exact rules text
//    specified for this pass, and a compact legend row under the header
//    spells the same three rules out for newcomers who may not hover every
//    cell.
// 4. **Integrated par boxes, at their true real-board coordinates.** The
//    six standard 1830 par values ($67/$71/$76/$82/$90/$100) sit, on the
//    real physical board, in a VERTICAL column at absolute board-column 6,
//    spanning rows 0-5 of the Ruby `MARKET` array (this component's
//    `y = 10..5`, since `y` here counts up from the bottom -- see the
//    coordinate-convention note above `REAL_MARKET_ROWS`). A prior pass
//    could not move the par ladder there because the backend still used
//    the OLD `x=0..5, y=0` coordinate contract; this refactor moves BOTH
//    sides to the real `x=6, y=5..10` column together (mirroring
//    `market::PAR_VALUE_LADDER` exactly), so there is no longer a separate
//    par-track cluster at all -- the six par cells are shaded and labeled
//    in place, inside the real matrix, exactly where the physical board
//    prints them. Note on placement: the verbatim board data puts this
//    column at x=6 out of 0-18 -- left-of-center, not the rightmost column.
//    This pass follows the sourced coordinates rather than relocating the
//    par cells to whichever column is visually "rightmost," since a
//    position chosen for appearance instead of accuracy would silently
//    disagree with the backend's real `PAR_VALUE_LADDER` and reintroduce
//    exactly the kind of displayed-vs-actual mismatch this whole refactor
//    exists to eliminate.
// 5. **Token stacking, via an independent grid item.** When more than one
//    company's `MarketPositionEntry` shares the same `(x, y)`, their ticker
//    badges are staggered with a small diagonal cascade
//    (`TOKEN_STACK_OFFSET_PX`) rather than overlapping in place. Token
//    wrapper elements are separate CSS grid children of their own,
//    explicitly placed at the same `gridColumn`/`gridRow` as their
//    coordinate -- independent of whether a background price cell exists
//    underneath, so a token is never silently dropped even for a
//    coordinate this component's real-shape mask doesn't cover. Cells/
//    wrappers use `overflow: visible` (as does the grid container) so a
//    deep stack spills visibly over neighboring cells rather than being
//    silently clipped.
// 6. **Ticker color palette.** Colors are assigned per `company_id` from a
//    fixed palette (`TICKER_COLORS`), not derived from anything the backend
//    sends -- purely a frontend legibility aid so the same corporation reads
//    as the same color everywhere on the board. An id outside the palette's
//    range falls back to a neutral gray rather than throwing, since this
//    component has no way to know the full roster ahead of time.
// 7. **Cell boundary lines.** Price-cell borders use `#3a4152` against the
//    `#161922` cell background so adjacent cells' shared edges read as a
//    clear, continuous grid of boundary lines -- the "token movement path"
//    between neighboring price steps -- rather than a loosely-spaced field
//    of soft-edged boxes. Zone tints (design note #3) and the par gold tint
//    (design note #4) both override this base background per cell, never
//    the border.
// 8. **Defensive token placement.** Every occupant in `marketGrid.positions`
//    is placed via a coordinate clamped into `[MARKET_MIN_X, MARKET_MAX_X]`
//    x `[MARKET_MIN_Y, MARKET_MAX_Y]` (the backend's own declared range),
//    independent of whether that cell falls inside `REAL_MARKET_ROWS`'s
//    authentic-shape mask. A token's actual on-chain position is always
//    rendered somewhere on the grid, even in the (currently believed
//    impossible, but not something this component can prove) case that
//    `market.rs`'s movement rules ever produced a position outside the real
//    cliffside shape -- matching HexGridRenderer's "unknown tile_id renders
//    a visible placeholder rather than silently nothing" honesty convention
//    instead of ever silently dropping a real corporation's token.
// 9. **Game-end ($350) cap -- SUPERSEDED BY DESIGN NOTE #27, kept for the
//    coordinate reference.** The top-right cell (`x=18, y=10`, the real
//    board's printed `$350`) is the coordinate `market::GAME_END_PRICE_TRIGGER`
//    watches -- see `market.rs`'s module doc comment for the important
//    caveat that this auto-end behavior is an explicit house rule for this
//    project, not verbatim 18xx-engine behavior (the real engine does not
//    tag this cell `:endgame`/`:close`). This component marks that cell
//    visually (a subtle red outline + a "GAME END" tooltip suffix) purely
//    as a player-facing hint; it has no effect on gameplay logic, which
//    lives entirely on-chain in `trading.rs`/`operations.rs`.
// 10. **Disconnected Par/IPO Tray.** A geometry-correction request asked to
//    relocate the par cells to the board's bottom rows; re-verifying the
//    sourced 18xx.games `MARKET` array (fresh fetch, full raw array) instead
//    confirmed the six par cells genuinely sit at `x=6, y=5..10` (a vertical
//    column from the board's middle row up to its top row) -- rows `y=0..4`
//    contain nothing but Brown/Orange/Yellow cells in the real data, no par
//    cells at all. So the main grid's par cells (design note #4) were left
//    exactly where the verbatim source puts them. What this pass adds
//    instead is a SEPARATE, purely supplementary panel -- `ParIpoTray` below
//    -- that exists alongside the main grid (not instead of it) as a quick
//    at-a-glance reference of the six standard par prices, matching the
//    physical game's own separate par-track component, plus a static marker
//    for any corporation currently (or ever previously) observed sitting on
//    its chosen par cell.
//    DATA SOURCE / HONEST LIMITATION: `MarketGridResponse` has no field
//    recording a corporation's ORIGINAL par choice once it starts moving
//    around the board (see `MarketPositionEntry` -- only a LIVE `(x, y)`,
//    design note #1's contract mirror) -- there is no `QueryMsg` that
//    returns "par history." `parMemoryStore` below is therefore a
//    session-local, purely client-observed cache, NOT a chain query result:
//    every time this component sees `marketGrid.positions` contain a
//    company sitting exactly on one of the six real par cells, it remembers
//    that `(company_id -> par price)` pairing at module scope (outside
//    React state, so it survives this component unmounting/remounting on a
//    tab switch, for as long as this browser tab's JS session lives) and
//    keeps showing that marker in the tray even after the company's live
//    token later moves elsewhere on the main grid during Operating Rounds --
//    this is what "leaves the initial indicator behind" means here, and is
//    genuinely derived from real observed on-chain positions, never
//    fabricated. KNOWN GAP: a client that opens the app for the first time
//    AFTER a company has already left its par cell has no way to retroactively
//    learn its historical par choice from this query alone -- that cell in
//    the tray simply stays empty for this client until a real
//    `GetParHistory`-style query (or an indexed on-chain event log) exists.
//    Flagged here explicitly rather than silently showing an empty tray as
//    if it meant "no company ever parred there."
// 11. **Visual sweep: authentic market color gradients, clipped to their
//    own cell.** Par cells (design note #4) and zone-tinted cells (design
//    note #3) used to fill with one FLAT `backgroundColor` -- readable, but
//    a flat sticker-like fill compared to the physical board's actual
//    printed cardstock shading. `PAR_VALUE_GRADIENTS`/`ZONE_GRADIENTS` add
//    a subtle diagonal lighter-to-darker `background` gradient instead, one
//    hand-paired shade pair per existing `PAR_VALUE_COLORS`/`ZONE_COLORS`
//    entry (matching this file's own established explicit-palette
//    convention rather than a runtime color-math lighten/darken helper).
//    `styles.cell`'s `overflow` flips from `visible` to `hidden` alongside
//    this so a gradient is always clipped exactly to its own cell box,
//    never bleeding across the grid's `gap` into a neighboring cell's
//    "panel fold" -- confirmed safe specifically because live company
//    tokens are NOT nested inside a `.cell` element at all (design note
//    #5's `tokenWrapper` is its own independent sibling grid item), so a
//    deep token stack still spills visibly over neighboring cells exactly
//    as before; only each cell's own background/content is newly clipped.
// 12. **Viewport maximization (Request F item 3).** `CELL_SIZE_PX` is no
//    longer used directly for layout -- it's now only the pre-measurement
//    fallback/ratio baseline. `gridWrapperRef`'s `ResizeObserver` measures
//    the space actually available to the grid (deliberately excluding the
//    Par/IPO tray sibling, which keeps its own natural width -- see
//    `styles.gridWrapper`) and derives the largest cell size that still
//    fits all `REAL_BOARD_COLUMNS` columns and `REAL_BOARD_ROWS` rows
//    inside it, clamped to `[MIN_CELL_SIZE_PX, MAX_CELL_SIZE_PX]`. Token
//    stack stagger (`TOKEN_STACK_OFFSET_PX`, design note #5) scales
//    proportionally via `deriveTokenStackOffsetPx` rather than staying a
//    fixed pixel count. `styles.root`/`styles.boardArea` both changed to
//    flex-fill their host pane (`width`/`height: "100%"`, `flex: 1`,
//    `minHeight: 0`) so real space reaches this component at all -- see the
//    matching `App.tsx` `boardPane` change.
// 13. **Dynamic price-text scaling.** This component is DOM/CSS-grid-based,
//    not canvas (design note #2), so "scale the font relative to cell
//    dimensions" translates to a dynamically-computed CSS `fontSize`
//    (`derivePriceFontSizePx(cellSize)`) rather than a literal canvas
//    `ctx.font` assignment -- same intent (price numbers stay large, bold,
//    and legible at any measured cell size), different rendering API.
//    Floored at `MIN_PRICE_FONT_SIZE_PX` so even the smallest clamped cell
//    size (`MIN_CELL_SIZE_PX`) keeps numbers readable, and scales up
//    linearly with `cellSize` exactly like the token stack offset (design
//    note #12's `deriveTokenStackOffsetPx`) already does. Base price-cell
//    font weight also bumped from 400 to 600 (par cells stay 700) so
//    numbers read as bold at every size, not just large.
// 14. **Chart vs. tray color decoupling.** A prior pass's `ParIpoTray` used
//    the same warm gold `PAR_VALUE_COLORS` palette as the main grid's par
//    ladder cells for each tray row's own background -- visually adjacent
//    to, and easy to confuse with, the main chart's warm Yellow/Orange/
//    Brown exception-zone tints (design note #3), even though the tray
//    itself never touched those zone colors directly. This pass gives the
//    tray its own neutral steel-gray palette (`PAR_TRAY_ROW_BG`/`_BORDER`),
//    completely independent of both `PAR_VALUE_COLORS`/`PAR_VALUE_GRADIENTS`
//    and `ZONE_COLORS`/`ZONE_GRADIENTS` -- the tray now reads as a distinct,
//    clean reference panel rather than a second copy of the chart's own
//    coloring. Each row keeps a small colored price-text accent (still
//    drawn from `PAR_VALUE_COLORS`) so the six standard prices remain
//    visually distinguishable from one another, without recoloring the
//    row's own background/border. Separately, on the main chart matrix
//    itself, zone-tinted cells (already fill only their exact sourced
//    Yellow/Orange/Brown coordinates -- see design note #1's "no rectangular
//    loop" and `REAL_MARKET_ROWS`, so no change was needed there) now render
//    their price number in bright, bold text (`ZONE_PRICE_TEXT_COLOR`)
//    against the existing soft `ZONE_GRADIENTS` fade, instead of the same
//    dim gray used for plain Normal-zone cells -- legible at a glance
//    exactly where the rule-altering coordinates are.
// 15. **Column-6 hard-block, and a real-data accuracy correction it
//    surfaced.** A prior pass added an inline `cell.x !== PAR_LADDER_COLUMN_X`
//    guard (informally called "design note #15" in that code's own comment,
//    formalized here as an actual numbered entry) so the par ladder's column
//    could never pick up a zone gradient even if the sourced data ever
//    mistagged it. This pass replaces that inline check with an explicit,
//    strict index comparison applied FIRST in the priority chain (before any
//    zone-gradient branch is even considered), so "column 6 never renders a
//    Yellow/Orange/Brown gradient" is structurally guaranteed by coordinate
//    alone, never by a cell's price number. VERIFIED AGAINST
//    `REAL_MARKET_ROWS` while making this change: the sourced data's real
//    Yellow/Orange/Brown cells are NOT all confined to `x = 0..5` the way a
//    quick glance suggests -- the board's bottom-left cliff rows (`y = 0`,
//    `1`, `2`) each end exactly at `x = 6` with a genuine Yellow/Orange
//    tag (`(6, 2)` = Yellow $60, `(6, 1)` = Yellow $50, `(6, 0)` = Orange
//    $40 -- all real, sourced values, NOT part of the six official
//    `PAR_VALUE_LADDER` cells, which only span `y = 5..10`). The PRIOR
//    pass's guard already silently suppressed color on these three real
//    cells too (an accurate side effect nobody had verified or flagged at
//    the time) -- this pass makes that suppression explicit and intentional
//    instead of an unexplained side effect: `PAR_COLUMN_NEUTRAL_FILL`, a
//    clean, high-contrast neutral charcoal, now fills every `x = 6` cell
//    that ISN'T one of the six official par cells, so those three real
//    coordinates read as a deliberate "no rule color in this column" choice
//    rather than an unstyled gap that happens to blend into the ordinary
//    cell background. Their tooltip (design note #16) still reports the
//    real Yellow/Orange rule that applies there -- only the color is
//    suppressed, the underlying sourced zone data is untouched and still
//    surfaced to the player. The six official par cells (`isParValueLadder`)
//    are unaffected -- they keep their own distinct gold
//    `PAR_VALUE_GRADIENTS` treatment exactly as before; that's a separate
//    par-value indicator system, not one of the "gameplay rule gradients"
//    this item's request named (Yellow/Orange/Brown).
//    SUPERSEDED by design note #20/item 1: this whole column-index hard-
//    block (`PAR_COLUMN_NEUTRAL_FILL`/`PAR_COLUMN_NEUTRAL_TEXT_COLOR`) and
//    the par cells' separate `PAR_VALUE_GRADIENTS` fill are both removed --
//    see that note for why a strict per-cell `zoneType` read (no column
//    index, no price lookup) is the correct rule going forward, including
//    for these same three `x = 6` cells and the six par-ladder cells this
//    note describes. Left here verbatim as the historical record of how
//    the column-6 mistagging was found and verified.
// 16. **Clean hover tooltips -- no raw coordinates.** Every cell's `title`
//    tooltip used to include a raw `(${cell.x}, ${cell.y})` array-index
//    string -- meaningful to a developer cross-checking `REAL_MARKET_ROWS`,
//    meaningless (or actively confusing) to a player. Removed outright. The
//    zone portion of the tooltip now also leads with the zone's own proper
//    name (`ZONE_LEGEND_LABELS`, e.g. "Yellow Zone"), not just its bare rule
//    sentence, so a hovering player sees which named zone they're in AND
//    what it does, e.g. `"Yellow Zone: Certificates here do not count toward
//    hand limits."` -- matching this item's own "dollar price value and its
//    respective active zone name rules" wording literally. This tooltip is
//    a native HTML `title` attribute, not a canvas-drawn overlay -- see
//    design note #2's own rationale for why this component is DOM/CSS-grid,
//    not `<canvas>` (unlike its `HexGridRenderer.tsx` sibling); "canvas
//    mouse overlay" in this item's request is read as this component's own
//    actual hover-tooltip mechanism.
// 17. **Upsized Par/IPO Tray.** The tray (design note #10) previously sized
//    itself almost entirely from its content (`minWidth: "180px"`, small
//    12px price text, 9px ticker badges) -- legible, but cramped next to the
//    much larger main matrix, and easy to skim past rather than read at a
//    glance like the physical game's own separate par-track board piece.
//    `styles.parTray` now claims a fixed, generous `flex: "0 0 340px"` (no
//    grow, no shrink -- so `boardArea`'s main grid, still `flex: 1`, can
//    never squeeze it back down regardless of viewport width) with wider
//    padding/row spacing, and its price/badge text is upsized well past the
//    main chart's own necessarily-small per-cell numbers (`parTrayPrice`
//    12px -> 26px, `parTrayMarkerBadge` 9px -> 14px) since this panel's only
//    job is being an easy-to-read reference sheet, not a dense 19x11 grid
//    squeezed into limited space the way the main matrix is.
// 18. **Final visual theme overhaul: charcoal/green cells, gold par-box
//    frame, upscaled legend.** Five items:
//    (1) Ordinary, non-exception cells now get an explicit, named
//    `NORMAL_CELL_BACKGROUND` (`#161922`) as a real branch of the
//    background-priority chain, instead of falling through to
//    `styles.cell.backgroundColor` as an unstated implicit default -- same
//    visible color as before (this file's cells were already uniform
//    charcoal), now an intentional, overwritten branch per this item's own
//    "overwrite the background coloring loops" wording.
//    (2) The `$350` game-end cell (`GAME_END_CELL_X/_Y`, design note #9)
//    gets a vibrant green `GAME_END_CELL_BACKGROUND` gradient fill --
//    highest priority in the chain -- plus dark high-contrast text
//    (`GAME_END_CELL_TEXT_COLOR`) and a matching dark-green outline
//    (replacing the prior red ring, which would have visually fought the
//    new green fill) as an unmistakable signal that landing here fires
//    `market::price_triggers_game_end`'s on-chain auto-end trigger.
//    (3) Yellow/Orange/Brown zone gradients (`ZONE_GRADIENTS`, design note
//    #3) are completely untouched by this pass -- verified by re-reading
//    the background-priority chain after this change: the game-end/par/
//    par-column branches all come BEFORE the zone-gradient branch, exactly
//    as before, so no real sourced Yellow/Orange/Brown cell's color changed.
//    (4) The six par-ladder cells (`PAR_VALUE_LADDER`, design note #4) now
//    get a `parGroupFrame` overlay -- one independent CSS grid item spanning
//    their full outer bounding box (`PAR_LADDER_COLUMN_X` column,
//    `PAR_LADDER_ROW_MIN..PAR_LADDER_ROW_MAX` rows), with a thick 4px gold
//    border and no fill, positioned via grid line placement so its box
//    includes the internal cell gaps and reads as one continuous frame with
//    no seams -- rather than six separate per-cell borders. Their tooltip
//    (design note #16) now appends "Starting IPO / Par Value Selection."
//    after the existing "Par Value $X -- valid starting price" text.
//    (5) The rule-zone legend (`styles.legend*`, design note #3) has its
//    fonts/swatch size/block gaps all upscaled well past the original small
//    print (11px/10px labels -> 17px/15px, swatch 12px -> 22px, item gap
//    14px -> 26px) to match this pass's companion `App.tsx` dashboard
//    upscaling (that file's own design note #12/item 5).
// 19. **Side-column legend relocation & final grid-scale maximization (this
//    pass).** The horizontal `styles.legend` row (design note #3/#18-5) that
//    used to sit directly under the header -- eating a full text-heavy row
//    of vertical space before the matrix even started -- is removed
//    outright. Its exact same content (`ZONE_DESCRIPTIONS`/
//    `ZONE_LEGEND_LABELS`/`ZONE_COLORS`, unchanged) now renders through a
//    new `MarketRulesLegend` component, stacked vertically as its own
//    swatch-over-label-over-description card per zone -- reading naturally
//    in a narrow column instead of a wide row. It's placed as a sibling
//    `aside` directly below `ParIpoTray` inside a new shared `sideColumn`
//    flex container (design note #10's tray keeps its own identity/styling
//    untouched; the legend is "right next to" it, per this item's own
//    either/or wording, rather than merged into its DOM). `styles.parTray`'s
//    old `flex: "0 0 340px"` (a WIDTH basis when it was a direct `boardArea`
//    row child) moves up to `sideColumn` itself; nested inside that column,
//    `parTray` and the new `legendColumn` instead use `flex: "0 0 auto"` /
//    `flex: "1 1 auto"` respectively (a HEIGHT basis in a column flex
//    context) so the tray keeps its natural content height and the legend
//    card stretches to fill whatever height remains below it.
//    With that header-row space reclaimed, `boardArea`'s `gridWrapper` (see
//    design note #12) has strictly more measured height to report to its
//    `ResizeObserver` on every render, so the matrix already grows into the
//    freed space automatically -- no extra code needed there. On top of
//    that, this pass also raises the matrix's own scale ceiling explicitly:
//    `MAX_CELL_SIZE_PX` 72 -> 120, and `derivePriceFontSizePx`'s scaling
//    ratio 0.35 -> 0.4, so a genuinely widescreen pane can grow cells (and
//    their price text) well past the old cap instead of plateauing early.
//    `MIN_CELL_SIZE_PX`/`MIN_PRICE_FONT_SIZE_PX` are untouched, so small
//    panes still degrade gracefully to the same legible floor as before.
//    Item 4's "keep base theme elements intact" constraint is honored by
//    construction: `NORMAL_CELL_BACKGROUND`, `GAME_END_CELL_BACKGROUND`, and
//    the real sourced `ZONE_GRADIENTS` exception-zone fills (design notes
//    #3/#18) are untouched branches of the same background-priority chain,
//    so they simply render at whatever the now-larger `cellSize` happens to
//    be -- same colors, bigger cells. The one exception that genuinely
//    needed new code: the gold `parGroupFrame` overlay's border/glow were
//    literal fixed pixel values (4px border, 10px blur) that would have
//    looked proportionally thinner as the matrix grew, so
//    `deriveParFrameBorderPx`/`deriveParFrameGlowPx` now scale both off the
//    live `cellSize` using the same baseline-ratio pattern as
//    `deriveTokenStackOffsetPx` (design note #12) -- the frame stays a
//    "thick, distinctive" border relative to the cells it encloses at any
//    matrix scale, not just at the old fixed size.
// 20. **Cell-Specific Tagged Color Fills (color calibration pass, items
//    1-2).** The background-priority chain (design notes #15/#18) used to
//    branch on TWO different things: `cell.isParValueLadder`/`cell.x ===
//    PAR_LADDER_COLUMN_X` (coordinate/derived-flag checks) for the par
//    column, and `cell.zoneType` for everything else -- exactly the
//    "sweep a column, don't just read the per-cell tag" pattern this item
//    was asked to eliminate. `REAL_MARKET_ROWS` itself already tags all
//    six official par cells (`$67`-`$100` at `x = 6`) as plain `"Normal"`
//    (see that constant's own doc comment) -- so a STRICT per-cell
//    `zoneType` read puts them in the same charcoal `NORMAL_CELL_BACKGROUND`
//    branch as every other Normal cell, no special case needed. The old
//    column-6 hard-block (`PAR_COLUMN_NEUTRAL_FILL`, design note #15) is
//    removed for the same reason: it suppressed the three real Yellow/
//    Orange `zoneType` cells at `(6, 0)`/`(6, 1)`/`(6, 2)` to a neutral
//    fill purely because of their column index, which is now exactly the
//    "sweep with color" anti-pattern to avoid -- those three cells render
//    their own real `ZONE_GRADIENTS` fill again. The full chain is now
//    just three branches: `isGameEndCell` (green, unchanged) ->
//    `zoneType !== "Normal"` (that zone's own gradient) -> `NORMAL_CELL_BACKGROUND`
//    (charcoal, everything else) -- see the render loop's own comment for
//    the exact code. `NORMAL_CELL_BACKGROUND`/`styles.priceText.color` are
//    both promoted to the former `PAR_COLUMN_NEUTRAL_FILL`/
//    `PAR_COLUMN_NEUTRAL_TEXT_COLOR` values (`#343a45`/`#c8ccd6`) rather
//    than the dimmer originals, satisfying this pass's own "high-contrast"
//    wording for every Normal cell uniformly, not just the former par
//    column. Item 2's ask -- keep the gold `parGroupFrame` border grouping
//    the six par cells -- required NO code change: that overlay was always
//    a separate, independent grid item positioned by `PAR_LADDER_COLUMN_X`/
//    `PAR_LADDER_ROW_MIN..MAX` (design note #18/item 4), never coupled to
//    the cells' own background fill, so it keeps grouping the six par
//    cells visually even now that their fill matches every other Normal
//    cell exactly as intended.
// 21. **Page-Level Stock Matrix Scrolling & Legend Typography (items 3-4).**
//    Item 3 mirrors `HexGridRenderer.tsx`'s own design note #27 for this
//    component's DOM/CSS-grid rendering (design note #2): `styles.root`
//    drops `overflow: "auto"` and `height: "100%"` (a percentage height
//    that only ever resolved against `App.tsx`'s `boardPane`, which no
//    longer imposes a definite height on purpose -- see that file's design
//    note #13, already in place from an earlier pass and shared by both
//    the Rail Map and Stock Market tabs, so no further `App.tsx` change was
//    needed this pass); `styles.gridWrapper` drops its own `overflow:
//    "auto"`/`minHeight`. Unlike `HexGridRenderer.tsx`'s `<canvas>`, this
//    grid needs no derived-height math at all -- a CSS grid's height is
//    already intrinsic to its content (row count times `cellSize`, plus
//    gaps), so removing the old `cellFromHeight` term from the
//    `ResizeObserver` callback (now `cellSize` is derived from available
//    WIDTH alone) is the only code change needed; the grid's own natural
//    height does the rest, cascading up through the unclamped flex chain
//    to the page, where the BROWSER's own scrollbar takes over. Item 4
//    upscales `legendLabel` (each zone's title, e.g. "Yellow Zone") and
//    `legendText` (its explanatory sentence) in the `MarketRulesLegend`
//    column specifically (17px/15px -> 23px/19px, `legendText` also bumped
//    to `fontWeight: 600` and a brighter color) -- NOT the shared
//    `parTrayTitle`/`parTrayHint` styles, which also drive the separate
//    `ParIpoTray` panel and weren't named by this item.

// 22. **Gold Par Frame Recolor & Certificate-Limit Tooltip Audit (styling/
//    tooltip polish pass).** Two items, visual/text only -- no grid
//    geometry, pricing data, or contract-state change:
//    (1) `styles.parGroupFrame`'s border (and its matching glow) recolored
//    from the prior `#ffd54a`/`rgba(255, 213, 74, ...)` to the explicitly
//    requested `#EAB308` gold / `rgba(234, 179, 8, ...)`. The single
//    continuous grouping-frame STRUCTURE itself (one independent grid item
//    spanning all six par cells' outer bounding box, design notes #18-20)
//    was already exactly this pass's ask -- there has been no separate
//    per-cell gold border anywhere in this file since design note #20
//    folded the six par cells into the same plain `NORMAL_CELL_BACKGROUND`
//    fill as every other Normal cell; only the frame's own color changed
//    here.
//    (2) Terminology audit: every tooltip-facing use of "hand limit(s)" in
//    `ZONE_DESCRIPTIONS` is replaced with the official 1830 term
//    "certificate limit" (`MarketRulesLegend`'s legend card renders these
//    same strings, so it picks up the same fix for free). Standard
//    (`zoneType === "Normal"`) cells -- which includes the six par cells,
//    since `REAL_MARKET_ROWS` itself tags them `"Normal"` (design note
//    #20) -- previously had no certificate-limit tooltip text at all;
//    they now append an explicit "Stocks count toward certificate limit."
//    line, the accurate counterpart to the Yellow/Orange/Brown zones'
//    explicit EXEMPTION wording, so hovering any cell states its
//    certificate-limit status one way or the other rather than only the
//    exempt zones saying anything.

// 23. **Par-Frame Layering Fix, Tooltip Simplification, and Station-Token
//    Markers (direct feedback pass).** Three items:
//    (1) **Gold par-frame layering fix.** The user reported the gold
//    `parGroupFrame` overlay (design notes #18/#20/#22) was NOT rendering as
//    one continuous rectangle -- it looked like each of the six par cells
//    had its own segment of gold border instead. Root cause, confirmed by
//    re-reading the CSS stacking rules: `parGroupFrame` was rendered LATER
//    in this file's JSX than the price cells (design note #4's `PRICE_GRID`
//    loop), so it looked like it should paint on top -- but every price
//    cell (`styles.cell`) sets `position: "relative"` while
//    `parGroupFrame` had no `position` at all (defaulting to `static`).
//    Per the CSS2.1 painting-order spec, POSITIONED elements (the cells)
//    always paint after NON-positioned elements (the frame) within the same
//    stacking context, regardless of DOM order -- so every price cell's own
//    steel-gray border (design note #7) was silently painting on top of the
//    gold frame wherever the two overlapped (every internal cell boundary
//    inside the six-cell span), leaving only the true OUTER perimeter edges
//    visible as continuous gold and every internal boundary looking like a
//    per-cell seam. Fixed by giving `parGroupFrame` its own explicit
//    `position: "relative"` + `zIndex: 6` (a real positioned element with a
//    real stacking order now, guaranteed above the cells), and giving
//    `styles.cell` an explicit `zIndex: 1` (below the frame) and
//    `styles.tokenWrapper` an explicit `zIndex: 10` (above the frame, so
//    live company tokens still render in front of it exactly as before) --
//    three explicit, ordered layers instead of relying on DOM-order/
//    position-type interplay that happened to work for tokens but not for
//    the frame.
//    (2) **Tooltip simplification.** Direct feedback: "the tooltip for
//    these values just needs to say 'Par Value' and the rule for the cell
//    (counts towards cert limit), the extra stuff is unnecessary." The par
//    cells' tooltip previously read four separate clauses joined together
//    (`Par Value $X -- valid starting price -- Stocks count toward
//    certificate limit. -- Starting IPO / Par Value Selection.`). Trimmed
//    to exactly the two the request named: `Par Value $X -- Stocks count
//    toward certificate limit.` The `-- valid starting price` and
//    `Starting IPO / Par Value Selection.` clauses are removed outright
//    (both were redundant restatements of the same "this is a par cell"
//    fact the leading "Par Value $X" label already establishes). Every
//    other cell's tooltip (zone-tinted and plain Normal cells) is
//    unaffected -- this item only touches the `cell.isParValueLadder`
//    branch of the title-parts array.
//    (3) **Station-token-style corporation markers, and the layout change
//    needed to fit them.** Direct feedback: "the corporation trackers on
//    here are too small to be read correctly... these trackers are the
//    same circular markers used as station tokens... move the separate
//    IPO/Par Track and the Legend to a row beneath the matrix, and expand
//    the matrix fully across the panel." Two changes:
//    (a) `tokenBadge` changes from an auto-width text pill (8px font,
//    2px/4px padding) to a fixed-diameter CIRCLE -- `borderRadius: "50%"`,
//    a flex-centered ticker label, sized by the new
//    `deriveTokenDiameterPx`/`deriveTokenFontSizePx` (scaling off the live
//    `cellSize` exactly like `derivePriceFontSizePx`/the old
//    `deriveTokenStackOffsetPx` already did, clamped to
//    `[MIN_TOKEN_DIAMETER_PX, MAX_TOKEN_DIAMETER_PX]`) -- matching the
//    physical 1830 game's own circular station-token pieces instead of the
//    prior small oval label. `deriveTokenStackOffsetPx` now scales off the
//    token's own live diameter (not a fixed cell-size ratio) so a deeper
//    stack still staggers by a sensible fraction of the new, larger token.
//    (b) To give these larger circles room without cramping the price
//    grid, `styles.boardArea` changes from a ROW layout (grid + a fixed-
//    width `sideColumn` sitting beside it) to a COLUMN layout: the price
//    grid now renders first, at the panel's FULL available width (its
//    `ResizeObserver`-measured `gridWrapper` no longer shares that width
//    with a side panel, so it can size cells larger before hitting
//    `MAX_CELL_SIZE_PX`), and the Par/IPO Tray + Market Rules Legend
//    (design notes #10/#19) move into a new `belowGridRow` -- the exact
//    "row beneath the matrix" the request asked for -- rendered below the
//    grid instead of beside it. `belowGridRow`'s two cards now use a WIDTH
//    flex basis (`flex: "1 1 340px"`, wrapping side by side or stacking on
//    a narrow viewport) rather than the old `sideColumn`'s HEIGHT flex
//    basis from when they were stacked vertically in a column beside the
//    grid.

// 24. **Par-Frame Text Clipping Fix & Token Cluster Layout (second direct
//    feedback pass).** Two items:
//    (1) **Par-cell number clipping, root cause.** The user reported the
//    gold `parGroupFrame` outline was "cutting off part of the numbers."
//    Root cause: design note #23(1)'s layering fix made the frame paint ON
//    TOP of the six par cells (`zIndex: 6` above the cells' `zIndex: 1`,
//    necessary so the frame reads as one continuous rectangle rather than a
//    segmented one) -- but the frame's border is a `box-sizing: border-box`
//    stroke drawn flush against the SAME column's left/right edges that
//    those six cells' own price text also starts from (`styles.cell` was
//    left-aligned, `justifyContent`/`alignItems: "flex-start"`, with only a
//    2-3px padding before the digits begin). At this file's now much larger
//    matrix scale (design note #19/item 3 raised `MAX_CELL_SIZE_PX` to
//    120), `deriveParFrameBorderPx` can scale the border past 10px thick --
//    comfortably wide enough to visually overlap the leftmost stroke of
//    "90"/"82"/"76"/"71"/"67"/"100" now that the frame paints above them.
//    Fixed by centering (not left-aligning) price text specifically for
//    `cell.isParValueLadder` cells (`justifyContent`/`alignItems: "center"`
//    on that cell's flex container, set per-cell at the render-loop call
//    site rather than in the shared `styles.cell` object, which stays
//    left-aligned for every ordinary cell) -- centered text has clearance
//    from the frame's border on both sides at every real cell size this
//    matrix reaches, rather than starting directly underneath it. The
//    absolutely-positioned "PAR" badge (`styles.parBadge`, anchored to the
//    cell's own bottom-right corner) is unaffected -- `justifyContent`/
//    `alignItems` only affect normal-flow flex children, not
//    absolutely-positioned ones.
//    (2) **Token size & multi-occupant cluster layout.** Direct feedback:
//    the circular station tokens (design note #23(3)(a)) were "too large,"
//    and needed "a way to represent them all when they're on the same
//    cell" -- the old approach both oversized a single token (diameter up
//    to 85% of the cell) AND, for a same-cell stack, cascaded them in a
//    straight diagonal line that only kept the front-most token fully
//    visible once three or more shared a cell (exactly what the PRR/NYC/
//    ERIE screenshot showed). Two changes: (a) `deriveTokenDiameterPx`'s
//    base ratio drops from `cellSize * 0.85` to `cellSize * 0.62`
//    (`MAX_TOKEN_DIAMETER_PX` 64 -> 46, `MIN_TOKEN_DIAMETER_PX` 20 -> 16) --
//    a single token now reads as a marker ON the cell, not something that
//    dominates it. (b) `deriveTokenDiameterPx` now also takes the cell's
//    live occupant count and shrinks every token in a multi-occupant cell
//    via `tokenCountScale` (a formula, `1.15 / sqrt(count)` floored at
//    0.45x -- not a hardcoded few-cases table, so it degrades gracefully
//    for any real occupant count, not just 2-3). (c) Positioning changes
//    from the old linear diagonal cascade (`deriveTokenStackOffsetPx`,
//    removed) to `deriveTokenClusterOffset`: a single occupant renders
//    dead-center in its cell; two or more are spread evenly around a small
//    ring (`index / count` around a full circle, radius scaled to the live
//    cell/token size) centered on the cell, so every token in a stack keeps
//    its own clear position and ticker label instead of the earlier
//    cascade progressively burying all but the front-most one. `zIndex:
//    10 + index` is kept on each token (design note #23(1)) as a tie-
//    breaker for whatever slight overlap remains at high occupant counts.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { FONT_SIZE } from "../styles/typography";
import { corporationLabel } from "../utils/corporationNames";

/* ------------------------------------------------------------------ */
/* Contract data mirrors -- see design note #1                        */
/* ------------------------------------------------------------------ */

/** Mirrors `msg.rs`'s `MarketPositionEntry` exactly. `price` is a
 *  wire-format `Uint128` (a decimal string) or `null` -- only ever `null`
 *  in the defensive case documented on that Rust field. */
export interface MarketPositionEntry {
  company_id: number;
  ticker: string;
  x: number;
  y: number;
  price: string | null;
}

/** Mirrors `msg.rs`'s `MarketGridResponse` exactly -- `QueryMsg::GetMarketGrid`'s
 *  response shape. */
export interface MarketGridResponse {
  game_id: number;
  positions: MarketPositionEntry[];
}

/* ------------------------------------------------------------------ */
/* Price + zone grid mirror -- see design notes #1/#3/#4               */
/* ------------------------------------------------------------------ */

/** Mirrors `market::MARKET_MIN_X`/`MARKET_MAX_X`/`MARKET_MIN_Y`/`MARKET_MAX_Y`
 *  exactly: 19 columns (x: 0-18), 11 rows (y: 0-10). This is the BACKEND's
 *  own coordinate contract, updated in this refactor to the real board's
 *  width -- used only to clamp/validate occupant placement, not to decide
 *  the visible shape (that's `REAL_MARKET_ROWS` below). */
const MARKET_MIN_X = 0;
const MARKET_MAX_X = 18;
const MARKET_MIN_Y = 0;
const MARKET_MAX_Y = 10;

function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Mirrors `state::ZoneType` exactly -- see design note #3 for the
 *  cumulative-semantics caveat. */
export type ZoneType = "Normal" | "Yellow" | "Orange" | "Brown";

/** One real price cell: `[price, zoneType]`. Index `i` within a row's
 *  `cells` array corresponds to board column `startX + i`. */
type RealCell = readonly [number, ZoneType];

interface RealMarketRow {
  y: number;
  startX: number;
  cells: readonly RealCell[];
}

/** The authentic 1830 stock market board, sourced VERBATIM from the
 *  open-source 18xx.games engine's `lib/engine/game/g_1830/game.rb`
 *  `MARKET` constant (see design note #1) -- byte-for-byte the same 11
 *  rows, prices, and zone assignments as the Rust `market::REAL_MARKET_ROWS`
 *  constant this mirrors. `y` here follows this component's existing
 *  top-down convention (`y = 10` is the real board's topmost, highest-price
 *  row / Ruby array index 0; `y = 0` is the bottommost row / Ruby array
 *  index 10) -- the SAME convention this file always used, so no other
 *  coordinate math changes. Every entry not called out as Yellow/Orange/
 *  Brown is `Normal`; the six par cells (`x = 6`, `y = 5..10`) are encoded
 *  here as plain `Normal` since `PAR_VALUE_LADDER` below is the
 *  authoritative source for those six coordinates' pricing/labeling and its
 *  values agree with this table's raw numbers anyway (both read $67/$71/
 *  $76/$82/$90/$100 at that column). */
const REAL_MARKET_ROWS: readonly RealMarketRow[] = [
  {
    y: 10,
    startX: 0,
    cells: [
      [60, "Yellow"], [67, "Normal"], [71, "Normal"], [76, "Normal"], [82, "Normal"],
      [90, "Normal"], [100, "Normal"], [112, "Normal"], [126, "Normal"], [142, "Normal"],
      [160, "Normal"], [180, "Normal"], [200, "Normal"], [225, "Normal"], [250, "Normal"],
      [275, "Normal"], [300, "Normal"], [325, "Normal"], [350, "Normal"],
    ],
  },
  {
    y: 9,
    startX: 0,
    cells: [
      [53, "Yellow"], [60, "Yellow"], [66, "Normal"], [70, "Normal"], [76, "Normal"],
      [82, "Normal"], [90, "Normal"], [100, "Normal"], [112, "Normal"], [126, "Normal"],
      [142, "Normal"], [160, "Normal"], [180, "Normal"], [200, "Normal"], [220, "Normal"],
      [240, "Normal"], [260, "Normal"], [280, "Normal"], [300, "Normal"],
    ],
  },
  {
    y: 8,
    startX: 0,
    cells: [
      [46, "Yellow"], [55, "Yellow"], [60, "Yellow"], [65, "Normal"], [70, "Normal"],
      [76, "Normal"], [82, "Normal"], [90, "Normal"], [100, "Normal"], [111, "Normal"],
      [125, "Normal"], [140, "Normal"], [155, "Normal"], [170, "Normal"], [185, "Normal"],
      [200, "Normal"],
    ],
  },
  {
    y: 7,
    startX: 0,
    cells: [
      [39, "Orange"], [48, "Yellow"], [54, "Yellow"], [60, "Yellow"], [66, "Normal"],
      [71, "Normal"], [76, "Normal"], [82, "Normal"], [90, "Normal"], [100, "Normal"],
      [110, "Normal"], [120, "Normal"], [130, "Normal"],
    ],
  },
  {
    y: 6,
    startX: 0,
    cells: [
      [32, "Orange"], [41, "Orange"], [48, "Yellow"], [55, "Yellow"], [62, "Normal"],
      [67, "Normal"], [71, "Normal"], [76, "Normal"], [82, "Normal"], [90, "Normal"],
      [100, "Normal"],
    ],
  },
  {
    y: 5,
    startX: 0,
    cells: [
      [25, "Brown"], [34, "Orange"], [42, "Orange"], [50, "Yellow"], [58, "Yellow"],
      [65, "Normal"], [67, "Normal"], [71, "Normal"], [75, "Normal"], [80, "Normal"],
    ],
  },
  {
    y: 4,
    startX: 0,
    cells: [
      [18, "Brown"], [27, "Brown"], [36, "Orange"], [45, "Orange"], [54, "Yellow"],
      [63, "Normal"], [67, "Normal"], [69, "Normal"], [70, "Normal"],
    ],
  },
  {
    y: 3,
    startX: 0,
    cells: [
      [10, "Brown"], [20, "Brown"], [30, "Brown"], [40, "Orange"], [50, "Yellow"],
      [60, "Yellow"], [67, "Normal"], [68, "Normal"],
    ],
  },
  {
    y: 2,
    startX: 1,
    cells: [
      [10, "Brown"], [20, "Brown"], [30, "Brown"], [40, "Orange"], [50, "Yellow"], [60, "Yellow"],
    ],
  },
  {
    y: 1,
    startX: 2,
    cells: [
      [10, "Brown"], [20, "Brown"], [30, "Brown"], [40, "Orange"], [50, "Yellow"],
    ],
  },
  {
    y: 0,
    startX: 3,
    cells: [
      [10, "Brown"], [20, "Brown"], [30, "Brown"], [40, "Orange"],
    ],
  },
];

/** The widest real row spans columns 0-18 (19 columns) -- used only to size
 *  the CSS grid's visible track count, matching the backend's
 *  `MARKET_MIN_X..MAX_X` contract exactly now (see design note #1: an
 *  occupant token can still be placed past this via an implicit grid
 *  track). */
const REAL_BOARD_COLUMNS = 19;

/** The real board's game-end cell -- see design note #9 and
 *  `market::GAME_END_PRICE_TRIGGER`/`market::price_triggers_game_end`. */
const GAME_END_CELL_X = 18;
const GAME_END_CELL_Y = 10;

/** Design note #18/item 2 (final visual theme pass): a vibrant, distinct
 *  green fill for the `$350` game-end cell, taking top priority over every
 *  other background in the priority chain below (par gradient, zone
 *  gradient, ordinary charcoal) -- landing here triggers
 *  `market::price_triggers_game_end`'s on-chain game-end termination, and
 *  this is the single most consequential coordinate on the whole board, so
 *  it gets the strongest, most unmistakable visual treatment rather than
 *  competing for attention with the par ladder's gold or the exception
 *  zones' warm tints. Same hand-paired lighter-to-darker diagonal gradient
 *  convention as `PAR_VALUE_GRADIENTS`/`ZONE_GRADIENTS` (design note #11),
 *  just in green instead of gold/amber/brown so it reads as its own
 *  distinct signal, not a variant of either existing palette. */
const GAME_END_CELL_BACKGROUND = "linear-gradient(155deg, #3fe07a 0%, #1fae4a 55%, #157a34 100%)";

/** Dark, high-contrast text color for the green `GAME_END_CELL_BACKGROUND`
 *  fill -- see design note #18. The game-end cell is the one remaining
 *  bright/light background in the grid (design note #20/item 1 removed the
 *  par cells' own former gold fill), so this dark-on-bright pairing is now
 *  a standalone case rather than one of a matching pair. */
const GAME_END_CELL_TEXT_COLOR = "#07260f";

function isRealMarketCell(x: number, y: number): boolean {
  const row = REAL_MARKET_ROWS.find((r) => r.y === y);
  if (!row) return false;
  return x >= row.startX && x < row.startX + row.cells.length;
}

/** Mirrors `market::PAR_VALUE_LADDER` exactly: `(price, x, y)`, the six
 *  standard 1830 par prices, now at their true real-board coordinates
 *  (a vertical column at `x=6`, spanning `y=5..10`) -- see design note #4.
 */
const PAR_VALUE_LADDER: ReadonlyArray<{ price: number; x: number; y: number }> = [
  { price: 67, x: 6, y: 5 },
  { price: 71, x: 6, y: 6 },
  { price: 76, x: 6, y: 7 },
  { price: 82, x: 6, y: 8 },
  { price: 90, x: 6, y: 9 },
  { price: 100, x: 6, y: 10 },
];

/** The par ladder's single, fixed column -- every `PAR_VALUE_LADDER` entry
 *  shares this `x`. Named/derived rather than hardcoded a second time, so
 *  the explicit zone-tint exclusion guard below (see the color-fill ternary
 *  further down, and its own doc comment) can never drift out of sync with
 *  where the par cells actually live if this column ever moved. */
const PAR_LADDER_COLUMN_X = PAR_VALUE_LADDER[0].x;

/** The par ladder's own row span (`y = 5..10`) -- see design note #18/item
 *  4. Derived from `PAR_VALUE_LADDER` itself (never hardcoded a second
 *  time) so the gold group-frame overlay below can never drift out of sync
 *  with where the six real par cells actually live, the same anti-drift
 *  rationale as `PAR_LADDER_COLUMN_X` just above. */
const PAR_LADDER_ROW_MIN = Math.min(...PAR_VALUE_LADDER.map((entry) => entry.y));
const PAR_LADDER_ROW_MAX = Math.max(...PAR_VALUE_LADDER.map((entry) => entry.y));

// `PAR_COLUMN_NEUTRAL_FILL`/`PAR_COLUMN_NEUTRAL_TEXT_COLOR` (design note
// #15's "hard-block any x = 6 cell from its own real zone color, paint it
// neutral instead" pair) are REMOVED as of design note #20/item 1 -- that
// hard-block was itself the "sweep an entire column" anti-pattern this
// pass was asked to eliminate. `NORMAL_CELL_BACKGROUND`/`styles.priceText`
// now serve exactly the role these two used to (the SAME promoted
// `#343a45`/`#c8ccd6` values, in fact), applied uniformly by `zoneType`
// alone rather than by column index, so the three real Yellow/Orange `x =
// 6` cells outside the official par range render their own true zone color
// again instead of being suppressed -- see design note #20 for the full
// rationale.

const PAR_VALUE_LADDER_BY_CELL: ReadonlyMap<string, number> = new Map(
  PAR_VALUE_LADDER.map((entry) => [cellKey(entry.x, entry.y), entry.price]),
);

interface PriceCell {
  x: number;
  y: number;
  price: number;
  zoneType: ZoneType;
  isParValueLadder: boolean;
  isGameEndCell: boolean;
  /** Design note #43: the leftmost cell of its row -- a LEFT CLIFF. A price
   *  here that would move left moves DOWN instead. */
  isLeftCliff: boolean;
  /** The rightmost cell of its row -- a RIGHT CLIFF. A price here that
   *  would move right moves UP instead. */
  isRightCliff: boolean;
}

/** Walks the hardcoded `REAL_MARKET_ROWS` coordinate array directly, cell by
 *  cell -- no rectangular sequential x/y loop, no formula -- and overlays
 *  the six `PAR_VALUE_LADDER` cells' fixed prices/labels on top (their raw
 *  table values already agree, see the note above `REAL_MARKET_ROWS`).
 *  Ordered highest row (`y = 10`) first, so the resulting array reads
 *  top-to-bottom exactly as it should render in the CSS grid below. */
function buildPriceGrid(): PriceCell[] {
  const cells: PriceCell[] = [];
  // Design note #43a: which coordinates exist at all, so a cliff can ask
  // whether the cell it would be pushed INTO is on the board.
  const occupied = new Set<string>();
  for (const row of REAL_MARKET_ROWS) {
    row.cells.forEach((_, index) => occupied.add(cellKey(row.startX + index, row.y)));
  }
  for (const row of REAL_MARKET_ROWS) {
    row.cells.forEach(([price, zoneType], index) => {
      const x = row.startX + index;
      const parOverride = PAR_VALUE_LADDER_BY_CELL.get(cellKey(x, row.y));
      cells.push({
        x,
        y: row.y,
        price: parOverride ?? price,
        zoneType,
        isParValueLadder: parOverride !== undefined,
        // Design note #27: ALWAYS false. The $350 cell is an ordinary top
        // -of-chart price, not a game-end trigger -- that condition is not
        // canonical 1830 and has been removed from the rules text too. The
        // flag and its green fill are kept in the type/style tables rather
        // than ripped out, so re-enabling it is a one-line change if the
        // house rule ever comes back deliberately.
        // `GAME_END_CELL_X`/`_Y` still name the cell; the `&& false` is the
        // switch. Written this way rather than deleting the coordinates so
        // restoring the house rule is one edit, not an archaeology exercise.
        isGameEndCell: false && x === GAME_END_CELL_X && row.y === GAME_END_CELL_Y,
        // Design note #43: cliffs are a property of the ROW, not of the
        // board's overall rectangle. `REAL_MARKET_ROWS` is jagged -- 19
        // cells at the top narrowing to 4 at the bottom -- so a row's own
        // first and last cells are its cliffs, and comparing against a
        // global min/max x would mark almost nothing.
        // Design note #43a: A CLIFF ONLY COUNTS IF THERE IS SOMEWHERE TO
        // GO. A left cliff redirects a leftward move DOWNWARD, so it is
        // only a cliff if a cell exists below it; the $10 floor at the
        // bottom-left has nothing beneath it and simply cannot move, so it
        // gets no arrow. Same in mirror for the right cliff and the $350
        // ceiling, which has no row above.
        //
        // Derived from the grid rather than hardcoding "$10" and "$350":
        // the two terminal prices are a CONSEQUENCE of the board's shape,
        // and a hardcoded pair would silently stop matching if the board
        // were ever re-cut.
        isLeftCliff: index === 0 && occupied.has(cellKey(x, row.y - 1)),
        isRightCliff:
          index === row.cells.length - 1 && occupied.has(cellKey(x, row.y + 1)),
      });
    });
  }
  return cells;
}

const PRICE_GRID: readonly PriceCell[] = buildPriceGrid();

/** Finds the market-chart cell a given share price sits in.
 *
 *  EXPORTED for the Offline Sandbox (design note #16). The sandbox has to
 *  produce a `MarketGridResponse` -- the same shape `GetMarketGrid` returns
 *  -- and a position on this chart is `(x, y)`, not a price. Without this,
 *  the sandbox's grid coordinates were hand-written separately from the
 *  prices its corporation cards displayed, and the two promptly disagreed:
 *  PRR read 112 on its card and sat on the 100 cell of the chart.
 *
 *  Real 1830 charts repeat some prices across rows, so this returns the
 *  FIRST match walking `REAL_MARKET_ROWS` in order. That is arbitrary but
 *  deterministic, and it is only ever used to place a mock token -- a live
 *  game gets its real `(x, y)` from the contract, which tracks the actual cell
 *  a marker has walked to rather than re-deriving it from the price.
 *
 *  Returns `null` for a price with no cell, which callers must treat as
 *  "not on the chart" rather than coercing to the origin -- `(0, 0)` is a
 *  real cell and a marker parked there would be a visible lie. */
export function marketCellForPrice(price: number): { x: number; y: number } | null {
  const cell = PRICE_GRID.find((candidate) => candidate.price === price);
  return cell ? { x: cell.x, y: cell.y } : null;
}

/** The rule zone a price sits in, or `null` if the price is not on the
 *  board at all.
 *
 *  Exported because the zones are RULES, not decoration, and three surfaces
 *  outside this chart now depend on them: the certificate count (Yellow and
 *  Orange shares are exempt from the limit), the Stock Round buy control
 *  (Brown allows buying several bank-pool shares at once), and the ledger.
 *  Those consumers must read the SAME table the chart colours itself from
 *  -- a second copy of "which prices are Brown" would drift the moment
 *  either was edited, and the failure mode is a player being told a rule
 *  that the board contradicts. */
/* ===================================================================
 *  DESIGN NOTE 187: PROJECTING THE DIVIDEND MOVE
 * ===================================================================
 *
 * The Dividends step asks a player to choose between paying out and
 * withholding, and in 1830 that choice MOVES THE TOKEN -- right along the
 * row if the corporation pays, left if it withholds. The panel offered the
 * two buttons and said nothing about the consequence, which is most of what
 * the decision actually turns on.
 *
 * `PRICE_GRID` is the real chart, so the destination is a lookup rather
 * than an estimate: find the cell at the current price, step one column,
 * and read the price there.
 *
 * SCOPE, stated because the omission is deliberate. This models the two
 * ORDINARY moves. It does NOT model the chart's edges and special cases --
 * the ledges, the right cliff, or the end-of-Stock-Round sold-out rise --
 * which `market.rs` implements properly and which depend on state this
 * function is not given. Where the step would leave the chart the
 * projection reports the price as unchanged, which is what a clamp does
 * and is never a worse answer than inventing a cell. The contract remains
 * the authority on where the token actually lands.
 */
export interface MarketProjection {
  /** Where the token ends up, or the current price when the move is
   *  blocked by the edge of the chart. */
  price: number;
  /** `true` when the token actually moves -- lets a caller distinguish
   *  "rises to $90" from "already at the ceiling". */
  moves: boolean;
}

export function projectDividendMove(
  currentPrice: number | null | undefined,
  choice: "pay" | "withhold",
): MarketProjection | null {
  if (currentPrice == null || !Number.isFinite(currentPrice)) return null;
  const cell = PRICE_GRID.find((candidate) => candidate.price === currentPrice);
  if (!cell) return null;
  const targetX = cell.x + (choice === "pay" ? 1 : -1);
  const next = PRICE_GRID.find(
    (candidate) => candidate.y === cell.y && candidate.x === targetX,
  );
  return next ? { price: next.price, moves: true } : { price: currentPrice, moves: false };
}

/**
 * Where the token lands when a player SELLS shares -- one row DOWN per
 * 10% block sold.
 *
 * The vertical counterpart to `projectDividendMove`, and it exists for the
 * same reason: selling moves the marker in 1830, and a sandbox that moved
 * cash and shares while leaving the chart frozen was showing a stock market
 * that no action could ever affect.
 *
 * `blocks` is how many 10% certificates went to the pool, because the drop
 * is per block rather than per transaction -- selling 30% in one message is
 * three rows, not one.
 *
 * TAKES A CELL, NOT A PRICE, and returns one. This chart repeats prices
 * across rows, so "the cell at $76" is ambiguous and walking down from the
 * wrong one lands somewhere the marker never stood. The caller tracks the
 * cell for exactly this reason -- see `SandboxMarketMark`.
 *
 * "Down" is `y - 1`, not `y + 1`: this chart's y axis is inverted relative
 * to the screen (see the walk below).
 *
 * SAME SCOPE CAVEAT as `projectDividendMove`, and it matters more here: the
 * real chart has ledges that catch a falling token and a bottom row it
 * cannot fall out of. This walks down cell by cell and stops when there is
 * no cell below, which reproduces the FLOOR correctly and the ledges not at
 * all. `market.rs` remains the authority; this is here so the sandbox's
 * marker moves in the right direction by the right number of steps.
 */
/** The chart cell at `(x, y)`, or `undefined` off the edge. */
function cellAt(x: number, y: number): PriceCell | undefined {
  return PRICE_GRID.find((candidate) => candidate.x === x && candidate.y === y);
}

export function projectShareSaleMove(
  from: { x: number; y: number },
  blocks: number,
): { price: number; x: number; y: number } | null {
  const start = cellAt(from.x, from.y);
  if (!start) return null;

  /* Walks with plain indices rather than a `find` closure per step: a
     callback that captures the loop's own cursor is the `no-loop-func`
     hazard, and the cell below is a coordinate lookup rather than a search
     that needs one.

     DOWN IS `y - 1`. The chart's y axis runs the opposite way to the
     screen's: `REAL_MARKET_ROWS` puts the top row (the $350 ceiling) at
     `y: 10` and the bottom at `y: 0`, and the renderer inverts it with
     `gridRow: 11 - cell.y`. Written as `y + 1` this walked UP the chart, so
     a sale RAISED the price -- and silently did nothing for any token
     already on the top row, which is where the fixture's PRR sits. Caught
     by the harness, which asserted the token moves and found it did not. */
  let { x, y } = start;
  let price = start.price;
  for (let step = 0; step < Math.max(0, Math.floor(blocks)); step += 1) {
    const below = cellAt(x, y - 1);
    if (!below) break;
    x = below.x;
    y = below.y;
    price = below.price;
  }
  return { price, x, y };
}

/**
 * Where the token lands on a dividend decision -- one column RIGHT when the
 * corporation pays, one LEFT when it withholds.
 *
 * The cell-carrying counterpart to `projectDividendMove`, for the same
 * reason `projectShareSaleMove` takes a cell: this chart repeats prices
 * across rows, so stepping from "the cell at $76" is ambiguous and the
 * caller tracks the marker's actual position (`SandboxMarketMark`).
 *
 * SAME SCOPE CAVEAT as the other two. This is the ordinary move. The
 * ledges, the right cliff and the end-of-round sold-out rise are
 * `market.rs`'s, and where the step would leave the chart the marker stays
 * put -- a clamp, never an invented cell.
 */
export function projectDividendCellMove(
  from: { x: number; y: number },
  choice: "pay" | "withhold",
): { price: number; x: number; y: number } | null {
  const start = cellAt(from.x, from.y);
  if (!start) return null;
  const next = cellAt(from.x + (choice === "pay" ? 1 : -1), from.y);
  return next ? { price: next.price, x: next.x, y: next.y } : start;
}

export function marketZoneForPrice(price: number | null | undefined): ZoneType | null {
  if (price == null || !Number.isFinite(price)) return null;
  return PRICE_GRID.find((candidate) => candidate.price === price)?.zoneType ?? null;
}

/** Whether shares priced here are exempt from a player's certificate limit
 *  -- true in Yellow, Orange and Brown. Named rather than left as an
 *  inline zone comparison because the same three-way test is made in two
 *  files, and `zone !== "Normal"` is easy to write as `=== "Yellow"` by
 *  mistake. */
export function isCertificateExemptZone(zone: ZoneType | null): boolean {
  return zone === "Yellow" || zone === "Orange" || zone === "Brown";
}

/** Whether a player may buy MULTIPLE bank-pool shares of a corporation in
 *  one turn -- the Brown zone's own additional allowance. */
export function allowsMultipleBankPoolBuys(zone: ZoneType | null): boolean {
  return zone === "Brown";
}

/** One distinct color per real par value, from brightest gold ($100) down
 *  to deep bronze ($67). Keyed by price so `PAR_VALUE_LADDER`'s own entries
 *  drive the lookup directly. NO LONGER applied to the main grid's own par
 *  cells as of design note #20/item 1 (those are now plain
 *  `NORMAL_CELL_BACKGROUND` like any other `"Normal"`-tagged cell, grouped
 *  instead by the gold `parGroupFrame` border -- design note #20/item 2) --
 *  this palette now serves ONLY the separate `ParIpoTray` panel's own
 *  price-text accent color (design note #14's deliberate chart/tray color
 *  decoupling), which was always independent of the main grid's fill
 *  system anyway. The former `PAR_VALUE_GRADIENTS` companion (the main
 *  grid's own par-cell gradient fill) is removed outright along with that
 *  fill. */
const PAR_VALUE_COLORS: Readonly<Record<number, string>> = {
  100: "#e0c060",
  90: "#d4a94c",
  82: "#c89339",
  76: "#bb7d26",
  71: "#af6713",
  67: "#a35100",
};
const FALLBACK_PAR_VALUE_COLOR = "#8a6d1f";

/* ------------------------------------------------------------------ */
/* Rule zone color fills -- see design note #3                        */
/* ------------------------------------------------------------------ */

// Design note #25: `ZONE_COLORS` is REMOVED. It existed only to paint the
// swatches in the deleted Market Rules Legend -- the grid cells themselves
// use `ZONE_GRADIENTS`. Its content lives on where it matters: every
// non-Normal cell carries `ZONE_LEGEND_LABELS` + `ZONE_DESCRIPTIONS` as its
// `title`, which is the tooltip coverage that made the legend redundant.

/** Gradient counterpart to `ZONE_COLORS` -- see the doc comment on
 *  `PAR_VALUE_GRADIENTS` just above for the full rationale; same
 *  hand-paired lighter/darker shading approach, one entry per real zone
 *  color. `Normal` has none (matching `ZONE_COLORS.Normal` being
 *  `undefined`) since an untinted cell has nothing to gradient. */
const ZONE_GRADIENTS: Readonly<Record<Exclude<ZoneType, "Normal">, string>> = {
  Yellow: "linear-gradient(155deg, #7a6a1c 0%, #5c5015 55%, #453b0f 100%)",
  Orange: "linear-gradient(155deg, #7a4d1c 0%, #5c3a15 55%, #45290f 100%)",
  Brown: "linear-gradient(155deg, #54371a 0%, #3d2811 55%, #2c1c0a 100%)",
};

/** Bright, bold price-text color for zone-tinted cells only (design note
 *  #14) -- reads clearly against every `ZONE_GRADIENTS` fade, unlike the
 *  dim `styles.priceText.color` used for plain Normal-zone cells. */
const ZONE_PRICE_TEXT_COLOR = "#f5f6fa";

/** Design note #18/item 1 (final visual theme pass), color-calibrated by
 *  design note #20/item 1: explicit, named, uniform dark charcoal/gray
 *  background for EVERY cell whose `zoneType` is `"Normal"` -- full stop.
 *  This now includes the six official par-ladder cells (`$67`-`$100` at
 *  `x = 6`) and every other `x = 6` cell tagged `"Normal"` in the sourced
 *  data, alongside the ordinary upper-row cells across `x = 0..5` -- see
 *  design note #20 for why folding the par cells into this same uniform
 *  treatment (instead of their own separate gold fill) is correct per the
 *  sourced data itself. Value promoted from the former
 *  `PAR_COLUMN_NEUTRAL_FILL` (`#343a45`) rather than the prior, dimmer
 *  `#161922` -- that constant was purpose-built and documented as a
 *  "high-contrast neutral charcoal," which is a better match for this
 *  item's own "high-contrast neutral dark charcoal/gray" wording than the
 *  original near-black value it replaces. */
const NORMAL_CELL_BACKGROUND = "#343a45";

/** Exact rules text specified for this pass -- shown both as each cell's
 *  tooltip suffix and in the legend row under the header. Deliberately
 *  cumulative wording (each tier states what it adds on top of the
 *  previous), matching this project's documented cumulative zone
 *  interpretation (design note #3). */
// Design note #22/item 2: "certificate limit" is the official 1830 term --
// every instance of "hand limit(s)" (the prior wording) is replaced here.
const ZONE_DESCRIPTIONS: Readonly<Record<Exclude<ZoneType, "Normal">, string>> = {
  Yellow: "Certificates here do not count toward the certificate limit.",
  Orange:
    "Exempt from the certificate limit AND a single player may exceed the 60% corporate ownership cap.",
  Brown:
    "Exempt from the certificate limit, exceeds 60% cap, and players can buy multiple bank pool shares per turn.",
};

const ZONE_LEGEND_LABELS: Readonly<Record<Exclude<ZoneType, "Normal">, string>> = {
  Yellow: "Yellow Zone",
  Orange: "Orange Zone",
  Brown: "Brown Zone",
};

/* ===================================================================
 *  DESIGN NOTE 196: THE ZONES ARE A VOCABULARY, NOT THIS CHART'S DECOR
 * ===================================================================
 *
 * The dividend panel has to render a price in its zone's colour and explain
 * the rule that colour stands for. Both facts already exist here --
 * `ZONE_GRADIENTS` paints the cells, `ZONE_LEGEND_LABELS` names them and
 * `ZONE_DESCRIPTIONS` states their rules -- and `marketZoneForPrice` is
 * already exported precisely because the zones are RULES rather than
 * decoration.
 *
 * What was NOT exportable was the colour, because the chart needs a
 * multi-stop CSS gradient for a cell and text needs one flat, legible ink.
 * Reaching for `ZONE_GRADIENTS` off-chart would produce a `background`
 * string assigned to a `color` property: silently ignored, and the text
 * would render in the default grey with nobody able to see why.
 *
 * So this is the flat text counterpart, hand-paired with each gradient and
 * lifted for contrast against a dark panel -- the same relationship
 * `ZONE_PRICE_TEXT_COLOR` has to the tinted cells, one step further along.
 * A second table of "which prices are Brown" is what this avoids; the
 * PRICES still come from `marketZoneForPrice` and this only says what a zone
 * looks like when it is a word rather than a cell.
 */
export const ZONE_TEXT_COLORS: Readonly<Record<Exclude<ZoneType, "Normal">, string>> = {
  Yellow: "#e3c951",
  Orange: "#e39a51",
  Brown: "#c08a5e",
};

/** "Yellow Zone -- Certificates here do not count toward the certificate
 *  limit." One string, so a tooltip cannot show the label without the rule
 *  or the rule without the label. */
export function marketZoneTooltip(zone: ZoneType | null): string | null {
  if (zone === null || zone === "Normal") return null;
  return `${ZONE_LEGEND_LABELS[zone]} -- ${ZONE_DESCRIPTIONS[zone]}`;
}

/** The flat text ink for a zone, or `null` for a price that is either off
 *  the chart or in an ordinary cell. Returning `null` rather than a default
 *  grey is deliberate: the caller then applies NO colour at all, so a
 *  Normal-zone price keeps whatever the surrounding panel gives it instead
 *  of being re-tinted to something that looks like a fourth zone. */
export function marketZoneTextColor(zone: ZoneType | null): string | null {
  if (zone === null || zone === "Normal") return null;
  return ZONE_TEXT_COLORS[zone];
}

/* ------------------------------------------------------------------ */
/* Ticker color palette -- see design note #6                         */
/* ------------------------------------------------------------------ */

/** Keyed by `public_company::CORE_PUBLIC_COMPANIES`'s fixed `company_id`s
 *  (1-8: PRR/NYC/CPR/B&O/C&O/ERIE/NNH/B&M). Purely a frontend legibility
 *  aid, not backend data. */
const TICKER_COLORS: Readonly<Record<number, string>> = {
  1: "#c0392b", // PRR
  2: "#2980b9", // NYC
  3: "#8e44ad", // CPR
  4: "#27ae60", // B&O
  5: "#d68910", // C&O
  6: "#16a085", // ERIE
  7: "#b03a2e", // NNH
  8: "#34495e", // B&M
};
const FALLBACK_TICKER_COLOR = "#5a6270";

function tickerColor(companyId: number): string {
  return TICKER_COLORS[companyId] ?? FALLBACK_TICKER_COLOR;
}

/* ------------------------------------------------------------------ */
/* Disconnected Par/IPO Tray -- see design note #10                   */
/* ------------------------------------------------------------------ */

interface ParMarker {
  companyId: number;
  ticker: string;
  price: number;
}

/** Buckets parred companies by their par price for the tray's rows.
 *
 *  Design note #24: derived from contract state on every render, not
 *  accumulated in a module-scoped cache. The cache it replaced had a
 *  documented first-load gap (it only knew what this session had watched
 *  happen) and, more importantly, could not represent a parred-but-unfloated
 *  company at all. More than one corporation can par at the same standard
 *  price, so each bucket is a list. */
function buildParMarkers(
  companies: ReadonlyArray<{ company_id: number; ticker: string; par_value: string | null }>,
): ReadonlyMap<number, ParMarker[]> {
  const byPrice = new Map<number, ParMarker[]>();
  for (const company of companies) {
    if (company.par_value === null) continue;
    const price = Number(company.par_value);
    if (!Number.isFinite(price)) continue;
    const marker: ParMarker = { companyId: company.company_id, ticker: company.ticker, price };
    const bucket = byPrice.get(price);
    if (bucket) bucket.push(marker);
    else byPrice.set(price, [marker]);
  }
  return byPrice;
}

/** The tray always lists all six standard prices highest-to-lowest,
 *  matching the physical game's own par track reading order. */
const PAR_TRAY_ROWS: readonly number[] = [100, 90, 82, 76, 71, 67];

/** Neutral steel-gray tray row background/border -- deliberately its own
 *  independent palette, NOT drawn from `PAR_VALUE_COLORS`/`PAR_VALUE_GRADIENTS`
 *  (the main grid's gold par-cell fills) or `ZONE_COLORS`/`ZONE_GRADIENTS`
 *  (the main grid's exception-zone fills) -- see design note #14. */
const PAR_TRAY_ROW_BG = "#1d2028";
const PAR_TRAY_ROW_BORDER = "#333947";

function ParIpoTray({ markersByPrice }: { markersByPrice: ReadonlyMap<number, ParMarker[]> }) {
  return (
    <aside style={styles.parTray}>
      <div style={styles.parTrayHeader}>
        <span style={styles.parTrayTitle}>Par / IPO Tray</span>
        <span style={styles.parTrayHint} title="Par prices set here; a company moves onto the grid once it floats.">
          Reference only -- markers are session-observed, not a live chain query
        </span>
      </div>
      {PAR_TRAY_ROWS.map((price) => {
        const markers = markersByPrice.get(price) ?? [];
        return (
          <div
            key={price}
            style={styles.parTrayRow}
            title={`Par $${price}`}
          >
            <span
              style={{
                ...styles.parTrayPrice,
                color: PAR_VALUE_COLORS[price] ?? FALLBACK_PAR_VALUE_COLOR,
              }}
            >
              ${price}
            </span>
            <div style={styles.parTrayMarkers}>
              {markers.length === 0 ? (
                <span style={styles.parTrayEmpty}>--</span>
              ) : (
                markers.map((marker) => (
                  <span
                    key={marker.companyId}
                    style={{ ...styles.parTrayMarkerBadge, backgroundColor: tickerColor(marker.companyId) }}
                    title={`${corporationLabel(marker.ticker)} -- parred at $${price}`}
                  >
                    {marker.ticker}
                  </span>
                ))
              )}
            </div>
          </div>
        );
      })}
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/* Market Rules Legend -- see design note #19/item 2. Same exact zone     */
/* content as the old horizontal `styles.legend` row, now stacked as a    */
/* vertical side-column card next to `ParIpoTray` instead of a wide row   */
/* under the header.                                                      */
/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */
/* Component                                                          */
/* ------------------------------------------------------------------ */

export interface StockMarketRendererProps {
  /** `QueryMsg::GetMarketGrid`'s response, verbatim. */
  marketGrid: MarketGridResponse;
  /** Design note #24: every corporation that has a PAR PRICE SET, floated
   *  or not.
   *
   *  RULES CORRECTION, and the reason this prop exists. A company's par is
   *  fixed the moment its President's Certificate is bought -- NOT when it
   *  floats. Floating is a later, separate event (60% sold), and a company
   *  can sit parred-but-unfloated for a long stretch of a Stock Round while
   *  players decide whether to back it.
   *
   *  The tray previously derived its markers by WATCHING the market grid:
   *  when a token appeared on a par cell, it remembered it. That could only
   *  ever show companies already on the chart -- which is to say floated
   *  ones -- so a parred, unfloated company was invisible on the very track
   *  whose job is to record that it has been parred. The observed-position
   *  cache is gone; this comes straight from `PublicCompanyState.par_value`,
   *  which the contract sets at presidency purchase.
   *
   *  Optional so callers with no game state (the placeholder path) simply
   *  render an empty track rather than needing a stub. */
  parredCompanies?: ReadonlyArray<{ company_id: number; ticker: string; par_value: string | null }>;
  className?: string;
}

/** Fallback/default cell size, used only until the `ResizeObserver` below
 *  reports a real measurement (see design note #19 -- the same viewport-
 *  maximization item this mirrors in `HexGridRenderer.tsx`). */
const CELL_SIZE_PX = 40;
const MIN_CELL_SIZE_PX = 22;
// Raised 72 -> 120 (design note #19/item 3): with the header-row legend
// relocated out of `boardArea`'s way, a genuinely widescreen pane can now
// measure enough available space to actually reach a much larger ceiling
// than the old ResizeObserver clamp allowed.
const MAX_CELL_SIZE_PX = 120;
const GRID_GAP_PX = 2;
// `REAL_BOARD_ROWS` (row count) is no longer needed here as of design note
// #21/item 3 -- `cellSize` is now derived from available WIDTH alone (see
// the `ResizeObserver` below); the grid's actual height is just however
// many rows its content naturally occupies, an ordinary CSS grid concern
// that needs no explicit row-count math.

/** Shrinks each token's diameter as more corporations share a single cell
 *  -- design note #24(2)(b). A formula (not a lookup table keyed to a
 *  handful of hardcoded counts) so it degrades gracefully for ANY real
 *  occupant count: 1 -> 1.0x (no shrink), 2 -> ~0.81x, 3 -> ~0.66x,
 *  4 -> ~0.58x, floored at 0.45x so even a large cluster's tokens stay
 *  above a legible minimum size rather than shrinking toward zero. */
function tokenCountScale(count: number): number {
  if (count <= 1) return 1;
  return Math.max(0.45, 1.15 / Math.sqrt(count));
}

/** Station-token circle diameter -- design note #23(3)(a), recalibrated by
 *  design note #24(2)(b) (direct feedback: "too large"). Base ratio scales
 *  off the live, dynamically-computed cell size (same pattern as
 *  `derivePriceFontSizePx`) at a smaller 0.62 ratio than the original 0.85
 *  pass, clamped so a single token is always legible
 *  (`MIN_TOKEN_DIAMETER_PX`) but reads as a marker ON a cell rather than
 *  dominating it (`MAX_TOKEN_DIAMETER_PX`) -- then further scaled down by
 *  `tokenCountScale` when more than one corporation shares the same cell,
 *  so a multi-occupant cluster still fits legibly. */
const MIN_TOKEN_DIAMETER_PX = 16;
const MAX_TOKEN_DIAMETER_PX = 46;
function deriveTokenDiameterPx(cellSize: number, occupantCount: number): number {
  const single = Math.max(MIN_TOKEN_DIAMETER_PX, Math.min(MAX_TOKEN_DIAMETER_PX, Math.round(cellSize * 0.62)));
  return Math.max(Math.round(MIN_TOKEN_DIAMETER_PX * 0.85), Math.round(single * tokenCountScale(occupantCount)));
}

/** Station-token ticker-label font size, scaled off the token's own live
 *  diameter (not cell size directly) so the label always fits the circle
 *  it's centered inside -- design note #23(3)(a). */
function deriveTokenFontSizePx(diameterPx: number): number {
  return Math.max(8, Math.round(diameterPx * 0.32));
}

/** Arranges N same-cell station tokens in a small evenly-spaced ring
 *  around the cell's own center, instead of the old linear diagonal
 *  cascade -- design note #24(2)(c). A single occupant sits dead-center
 *  (`{ x: 0, y: 0 }`); two or more are spread evenly around a full circle
 *  (`index / count` of a full turn), radius scaled to the live cell/token
 *  size, so every token in a stack keeps a distinct, individually-readable
 *  position instead of the earlier cascade progressively burying all but
 *  the front-most token as the stack grew past two or three. */
function deriveTokenClusterOffset(
  index: number,
  count: number,
  cellSize: number,
  diameterPx: number,
): { x: number; y: number } {
  if (count <= 1) return { x: 0, y: 0 };
  const radius = Math.min(cellSize * 0.42, Math.max(8, diameterPx * 0.6));
  const angle = (index / count) * 2 * Math.PI - Math.PI / 2;
  return { x: Math.round(Math.cos(angle) * radius), y: Math.round(Math.sin(angle) * radius) };
}

/** The gold `parGroupFrame` overlay's border thickness at the ORIGINAL fixed
 *  cell size -- kept as the ratio baseline `deriveParFrameBorderPx` scales
 *  against, the same baseline-ratio pattern `derivePriceFontSizePx`/
 *  `deriveTokenDiameterPx` use (design note #19/item 4). */
const BASE_PAR_FRAME_BORDER_PX = 4;
/** Same baseline pattern for the frame's soft outer glow blur radius. */
const BASE_PAR_FRAME_GLOW_PX = 10;

/** Scales the gold par-box frame's border thickness proportionally to the
 *  live, dynamically-computed cell size, so the frame stays a "thick,
 *  distinctive" outline relative to the six cells it encloses at any matrix
 *  scale -- see design note #19/item 4. */
function deriveParFrameBorderPx(cellSize: number): number {
  return Math.max(3, Math.round(cellSize * (BASE_PAR_FRAME_BORDER_PX / CELL_SIZE_PX)));
}

/** Scales the gold par-box frame's outer glow blur radius alongside its
 *  border thickness -- see design note #19/item 4. */
function deriveParFrameGlowPx(cellSize: number): number {
  return Math.max(6, Math.round(cellSize * (BASE_PAR_FRAME_GLOW_PX / CELL_SIZE_PX)));
}

/** Floor a price cell's text can shrink to, even at `MIN_CELL_SIZE_PX` --
 *  see design note #13. */
const MIN_PRICE_FONT_SIZE_PX = 9;

/** Scales price-cell text proportionally to the live, dynamically-measured
 *  cell size (design note #13) -- the DOM/CSS-grid equivalent of the
 *  canvas-style `ctx.font = ...px` scaling this was requested as, translated
 *  to this component's actual rendering approach (design note #2). */
function derivePriceFontSizePx(cellSize: number): number {
  // Ratio raised 0.35 -> 0.4 (design note #19/item 3) so price text keeps
  // pace with the raised `MAX_CELL_SIZE_PX` ceiling instead of looking
  // relatively smaller inside the now-larger cells.
  return Math.max(MIN_PRICE_FONT_SIZE_PX, Math.floor(cellSize * 0.4));
}

interface CellOccupantGroup {
  key: string;
  x: number;
  y: number;
  occupants: MarketPositionEntry[];
}

export function StockMarketRenderer({ marketGrid, parredCompanies, className }: StockMarketRendererProps) {
  // Viewport maximization (design note #19 / Request F item 3), un-clamped
  // from viewport HEIGHT by design note #21/item 3: the grid's cell size is
  // no longer the fixed `CELL_SIZE_PX` constant -- a `ResizeObserver` on
  // `gridWrapperRef` measures the actual available WIDTH for the grid
  // (independent of the Par/IPO tray + legend sideColumn sibling, which
  // keeps its own fixed width) and derives the largest cell size that fits
  // all `REAL_BOARD_COLUMNS` columns inside it. This is a CSS grid, not a
  // canvas -- it needs no explicit pixel HEIGHT at all; the grid element's
  // own `gridAutoRows`/row count already gives it a real, content-driven
  // height (`REAL_BOARD_ROWS * cellSize` plus gaps) automatically, which is
  // exactly what lets that height cascade up through `App.tsx`'s now
  // fully un-clamped flex chain to the page itself instead of being
  // shrunk to also fit inside a bounded pane height.
  const gridWrapperRef = useRef<HTMLDivElement | null>(null);
  const [cellSize, setCellSize] = useState(CELL_SIZE_PX);

  useEffect(() => {
    const wrapper = gridWrapperRef.current;
    if (!wrapper) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width } = entry.contentRect;
      if (width < 1) return;
      const cellFromWidth = (width - GRID_GAP_PX * (REAL_BOARD_COLUMNS - 1)) / REAL_BOARD_COLUMNS;
      const next = Math.floor(Math.max(MIN_CELL_SIZE_PX, Math.min(MAX_CELL_SIZE_PX, cellFromWidth)));
      setCellSize((prev) => (prev === next ? prev : next));
    });
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, []);

  // Station-token sizing (design notes #23(3)(a)/#24(2)) is computed per
  // cell in the token render loop below, since diameter now also depends on
  // that cell's own live occupant count (`tokenCountScale`), which varies
  // cell by cell.
  const priceFontSizePx = derivePriceFontSizePx(cellSize);
  // Gold par-box frame border/glow, scaled off the same live `cellSize` --
  // see design note #19/item 4.
  const parFrameBorderPx = deriveParFrameBorderPx(cellSize);
  const parFrameGlowPx = deriveParFrameGlowPx(cellSize);

  // Groups live company positions by cell so multi-occupant cells can be
  // staggered -- see design note #5. Built as a plain typed array (not
  // `Array.from(map.entries())`) so the token-wrapper render below doesn't
  // depend on `Map` iterator generics being fully resolved by whatever `lib`
  // this environment's bare `tsc` run happens to see.
  const cellOccupantGroups = useMemo<CellOccupantGroup[]>(() => {
    const groupsByKey = new Map<string, CellOccupantGroup>();
    for (const position of marketGrid.positions) {
      const x = clamp(position.x, MARKET_MIN_X, MARKET_MAX_X);
      const y = clamp(position.y, MARKET_MIN_Y, MARKET_MAX_Y);
      const key = cellKey(x, y);
      const existing = groupsByKey.get(key);
      if (existing) {
        existing.occupants.push(position);
      } else {
        groupsByKey.set(key, { key, x, y, occupants: [position] });
      }
    }
    const groups: CellOccupantGroup[] = [];
    groupsByKey.forEach((group) => groups.push(group));
    return groups;
  }, [marketGrid.positions]);

  /* Design note #24: derived, not observed. The old version of this block
   * watched `marketGrid.positions` for tokens landing on par cells and
   * accumulated them in a module-scoped cache. That is gone -- it could
   * only ever know about companies already ON the chart, which excluded
   * exactly the parred-but-unfloated case the track is supposed to show. */
  const parMarkersByPrice = useMemo(
    () => buildParMarkers(parredCompanies ?? []),
    [parredCompanies],
  );

  return (
    <div style={styles.root} className={className}>
      <div style={styles.header}>
        <span style={styles.headerTitle}>Stock Market</span>
        <span style={styles.headerHint}>
          Game #{marketGrid.game_id} -- {marketGrid.positions.length}{" "}
          compan{marketGrid.positions.length === 1 ? "y" : "ies"} trading
        </span>
      </div>

      {/* Rule zone legend -- relocated out of this horizontal header-row
          spot into the vertical `MarketRulesLegend` side-column card next
          to `ParIpoTray` below (see design note #19/item 2). Removing it
          from here also hands `boardArea` its full available height. */}

      {/* Design note #25: matrix and par track SIDE BY SIDE.
          The tray used to sit in a row beneath the matrix next to a rules
          legend. The matrix is far taller than it is wide at most window
          sizes, so that left a tall column of dead space to its right while
          pushing the track off the bottom of the screen. The track now
          fills that whitespace, and the legend is deleted outright -- every
          zone cell already carries its rule as a `title` tooltip, so the
          legend was a second copy of text the grid itself provides on
          hover. */}
      <div style={styles.boardRow}>
      <div style={styles.boardArea}>
        <div ref={gridWrapperRef} style={styles.gridWrapper}>
          <div
            style={{
              ...styles.grid,
              gridTemplateColumns: `repeat(${REAL_BOARD_COLUMNS}, ${cellSize}px)`,
              gridAutoColumns: `${cellSize}px`,
              gridAutoRows: `${cellSize}px`,
            }}
          >
          {/* Background price cells -- only the real, authentic-shape
              coordinates (see design note #1). Everything else in the
              backend's addressable space is simply never rendered here,
              which is what masks out the cliffside gaps. */}
          {PRICE_GRID.map((cell) => {
            // TAG-DRIVEN color priority (design note #20/item 1 -- REPLACES
            // the old coordinate/index-based priority chain: no `cell.x`
            // column check, no `cell.price` lookup gating the fill choice,
            // only `cell.isGameEndCell` and `cell.zoneType`, exactly the two
            // structural tags this pass was asked to key off of):
            //   1. The game-end cell (`isGameEndCell`) -- vibrant green
            //      `GAME_END_CELL_BACKGROUND`, highest priority (item 3 of
            //      this pass keeps this untouched).
            //   2. Any cell whose `zoneType` isn't `"Normal"` -- its real
            //      sourced `ZONE_GRADIENTS` fill. This now ALSO applies to
            //      the three real `x = 6` cells at `y = 0, 1, 2` (genuine
            //      Yellow/Orange in `REAL_MARKET_ROWS`), which design note
            //      #15's old column-index hard-block used to suppress to a
            //      neutral fill regardless of their real tag -- exactly the
            //      "sweep an entire column" anti-pattern this item asked to
            //      eliminate.
            //   3. Every `"Normal"`-tagged cell -- the uniform
            //      `NORMAL_CELL_BACKGROUND` charcoal. This now ALSO includes
            //      the six official par-ladder cells (`$67`-`$100` at
            //      `x = 6`): `REAL_MARKET_ROWS` itself tags all six as
            //      `"Normal"` (see the doc comment above that constant), so
            //      a strict per-cell tag read puts them here, not in a
            //      separate gold-fill branch -- their own gold `PAR_VALUE_GRADIENTS`
            //      fill is removed. They stay visually grouped as starting
            //      options purely via the `parGroupFrame` gold BORDER below
            //      (design note #20/item 2, unchanged) plus their own bold
            //      text weight and "PAR" badge, not a special background.
            const gradient = cell.isGameEndCell
              ? GAME_END_CELL_BACKGROUND
              : cell.zoneType !== "Normal"
                ? ZONE_GRADIENTS[cell.zoneType]
                : NORMAL_CELL_BACKGROUND;
            // Tooltip text (design note #16, extended by design note
            // #18/item 4) -- price, plus the zone's own proper name
            // alongside its rule (never a raw coordinate index), plus the
            // par ladder's own "Starting IPO / Par Value Selection." suffix
            // for exactly the six official par cells. Unaffected by design
            // note #20's fill-color rework -- this was always sourced from
            // `cell.zoneType`/`cell.isParValueLadder` directly, never from
            // column index.
            const zoneLabel = cell.zoneType !== "Normal" ? ZONE_LEGEND_LABELS[cell.zoneType] : undefined;
            const zoneDescription =
              cell.zoneType !== "Normal" ? ZONE_DESCRIPTIONS[cell.zoneType] : undefined;
            // Design note #22/item 2: every standard (`"Normal"`-tagged)
            // cell -- which includes the six par cells, see that note --
            // now states its certificate-limit status explicitly, the
            // counterpart to the Yellow/Orange/Brown zones' own explicit
            // exemption wording above.
            const certificateLimitNote =
              cell.zoneType === "Normal" ? "Stocks count toward certificate limit." : undefined;
            // Design note #23(2): par cells' tooltip trimmed to exactly the
            // two clauses requested -- "Par Value $X" and the certificate-
            // limit rule -- dropping the redundant "valid starting price" /
            // "Starting IPO / Par Value Selection." restatements.
            const titleParts = [
              cell.isParValueLadder ? `Par Value $${cell.price}` : `$${cell.price}`,
              zoneLabel && zoneDescription ? `${zoneLabel}: ${zoneDescription}` : undefined,
              certificateLimitNote,
              cell.isGameEndCell ? "GAME END -- reaching this cell ends the game" : undefined,
              // Design note #43: what the arrow in the corner means.
              cell.isRightCliff
                ? "Right cliff: a price that would move right moves UP instead."
                : undefined,
              cell.isLeftCliff
                ? "Left cliff: a price that would move left moves DOWN instead."
                : undefined,
            ].filter(Boolean);
            return (
              <div
                key={cellKey(cell.x, cell.y)}
                style={{
                  ...styles.cell,
                  gridColumn: cell.x + 1,
                  gridRow: 11 - cell.y,
                  // `background` (the gradient/flat fill) always fully
                  // replaces `backgroundColor` now -- design note #18/item 1
                  // means even the "no special treatment" case
                  // (`NORMAL_CELL_BACKGROUND`) is an explicit value here
                  // rather than an omitted override that fell through to
                  // `styles.cell`'s own plain `backgroundColor`.
                  background: gradient,
                  // The green fill (item 2) is now the primary "this cell is
                  // special" signal for the game-end coordinate, so its
                  // outline is a crisp dark-green edge that frames the fill
                  // rather than the prior red ring, which would visually
                  // clash with -- and read as contradicting -- the new green
                  // background.
                  outline: cell.isGameEndCell ? "2px solid #0d3319" : undefined,
                  outlineOffset: cell.isGameEndCell ? "-2px" : undefined,
                  // Design note #24(1): the six par-ladder cells center
                  // their price text instead of the ordinary left-aligned
                  // layout, so it clears the gold `parGroupFrame`'s own
                  // left/right border (which now paints ON TOP of these
                  // cells, design note #23(1)) on both sides instead of
                  // starting directly underneath it.
                  justifyContent: cell.isParValueLadder ? "center" : "flex-start",
                  alignItems: cell.isParValueLadder ? "center" : "flex-start",
                }}
                title={titleParts.join(" -- ")}
              >
                {/* ---- Design note #43: cliff arrows ---------------------
                    The board's edges are RULES, and until now the only
                    place they were stated was a tooltip nobody hovers. A
                    price against the right edge moves UP when it would move
                    right; against the left edge it moves DOWN when it would
                    move left. Two glyphs in the corner say that at a glance.

                    Colour follows consequence, not direction of travel:
                    green up on the right because being pushed up is good
                    for a shareholder, red down on the left because being
                    pushed down is not. Both sit in the top-right corner as
                    specified -- a row's leftmost and rightmost cells are
                    never the same cell except in a one-cell row, and this
                    board has none, so they cannot collide. */}
                {cell.isRightCliff && (
                  <span style={{ ...styles.cliffArrow, ...styles.cliffArrowUp }} aria-hidden="true">
                    &#9650;
                  </span>
                )}
                {cell.isLeftCliff && (
                  <span
                    style={{ ...styles.cliffArrow, ...styles.cliffArrowDown }}
                    aria-hidden="true"
                  >
                    &#9660;
                  </span>
                )}
                <span
                  style={{
                    ...styles.priceText,
                    // Dynamic font scaling (design note #13): sized off the
                    // live measured `cellSize`, not a fixed pixel value.
                    fontSize: `${priceFontSizePx}px`,
                    // TAG-DRIVEN text color (design note #20/item 1, mirrors
                    // the background chain above exactly): dark,
                    // high-contrast text for the green game-end fill, bright
                    // `ZONE_PRICE_TEXT_COLOR` for any real zone-tinted cell,
                    // and the promoted-for-contrast `styles.priceText.color`
                    // for every plain `"Normal"` cell -- including the six
                    // par-ladder cells now that they share that same
                    // charcoal background, so text brightness can never
                    // disagree with whether a background tint actually
                    // rendered.
                    color: cell.isGameEndCell
                      ? GAME_END_CELL_TEXT_COLOR
                      : cell.zoneType !== "Normal"
                        ? ZONE_PRICE_TEXT_COLOR
                        : styles.priceText.color,
                    // Par-ladder cells keep bold weight even without their
                    // own special fill anymore -- alongside the "PAR" badge
                    // and the gold `parGroupFrame` border, this is one more
                    // small signal (not a color) that these six are starting
                    // options, not just ordinary Normal cells.
                    fontWeight:
                      cell.isGameEndCell || cell.isParValueLadder
                        ? 700
                        : cell.zoneType !== "Normal"
                          ? 700
                          : 600,
                  }}
                >
                  {cell.price}
                </span>
                {cell.isParValueLadder && <span style={styles.parBadge}>PAR</span>}
                {cell.isGameEndCell && <span style={styles.gameEndBadge}>END</span>}
              </div>
            );
          })}

          {/* Gold Par Box grouping frame -- design note #18/item 4. One
              independent grid item spanning the par ladder's full outer
              bounding box (`x = PAR_LADDER_COLUMN_X` column, `y = 5..10`
              rows -- see `PAR_VALUE_LADDER`), rather than six separate
              per-cell borders: a CSS grid item that spans multiple
              rows/columns occupies the full continuous box from the start
              edge of its first row/column to the end edge of its last,
              INCLUDING the `gap` gutters between the individual cells inside
              that span -- so a single thick gold `border` here traces one
              unbroken frame around the whole six-cell block, with no visible
              seam at the internal cell gaps, exactly as this item asked for
              ("a continuous, thick, distinctive gold outline frame
              completely enclosing those six blocks"). No fill (`background`
              stays transparent) and `pointerEvents: "none"` so it never
              covers the six cells' own backgrounds/tooltips/click targets
              underneath -- purely a border overlay. */}
          <div
            style={{
              ...styles.parGroupFrame,
              gridColumn: PAR_LADDER_COLUMN_X + 1,
              gridRow: `${11 - PAR_LADDER_ROW_MAX} / ${11 - PAR_LADDER_ROW_MIN + 1}`,
              // Border/glow scaled off the live `cellSize` -- see design
              // note #19/item 4 -- rather than the flat fixed pixel values
              // `styles.parGroupFrame` still carries as its pre-measurement
              // fallback.
              borderWidth: `${parFrameBorderPx}px`,
              boxShadow: `0 0 ${parFrameGlowPx}px rgba(234, 179, 8, 0.45)`,
            }}
          />

          {/* Live company tokens -- placed as independent grid items (see
              design note #5/#8) so a token is never silently dropped even
              if its coordinate falls outside `REAL_MARKET_ROWS`'s mask or
              has no rendered background price cell for any other reason. */}
          {cellOccupantGroups.map((group) => {
            // Design note #24(2): diameter (and therefore font size) is
            // computed per cell, off that cell's own live occupant count --
            // a lone token renders at full size; a cluster shrinks so every
            // member stays legible.
            const occupantCount = group.occupants.length;
            const tokenDiameterPx = deriveTokenDiameterPx(cellSize, occupantCount);
            const tokenFontSizePx = deriveTokenFontSizePx(tokenDiameterPx);
            return (
              <div
                key={group.key}
                style={{ ...styles.tokenWrapper, gridColumn: group.x + 1, gridRow: 11 - group.y }}
              >
                {group.occupants.map((occupant, index) => {
                  const offset = deriveTokenClusterOffset(index, occupantCount, cellSize, tokenDiameterPx);
                  return (
                    <span
                      key={occupant.company_id}
                      style={{
                        ...styles.tokenBadge,
                        backgroundColor: tickerColor(occupant.company_id),
                        width: `${tokenDiameterPx}px`,
                        height: `${tokenDiameterPx}px`,
                        fontSize: `${tokenFontSizePx}px`,
                        top: `calc(50% + ${offset.y}px - ${tokenDiameterPx / 2}px)`,
                        left: `calc(50% + ${offset.x}px - ${tokenDiameterPx / 2}px)`,
                        zIndex: 10 + index,
                      }}
                      title={`${corporationLabel(occupant.ticker)} -- $${occupant.price ?? "?"}`}
                    >
                      {occupant.ticker}
                    </span>
                  );
                })}
              </div>
            );
          })}
          </div>
        </div>
      </div>

      {/* Design note #25: the par track, in the whitespace beside the
          matrix. `flex: 0 0 auto` so it keeps its natural width and the
          grid's own `ResizeObserver` measures only what is left. */}
      <ParIpoTray markersByPrice={parMarkersByPrice} />
      </div>
    </div>
  );
}

export default StockMarketRenderer;

/* ------------------------------------------------------------------ */
/* Inline styles                                                      */
/* ------------------------------------------------------------------ */
// Plain inline style objects, matching App.tsx's existing convention (no
// CSS framework/file in this project yet).

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "16px",
    backgroundColor: "#0b0d12",
    borderRadius: "8px",
    color: "#e6e8ef",
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
    // Design note #21/item 3: `overflow: "auto"` removed outright -- that
    // was this panel's own inner scrollbar, exactly the "cramped inner
    // frame window" this item asks to eliminate. `height: "100%"` is
    // removed too -- a percentage height only ever resolves against an
    // ANCESTOR's own definite height, which `App.tsx`'s `boardPane` (design
    // note #13 there) no longer provides on purpose. This panel now simply
    // sizes to its own content's real height, same as any ordinary block
    // element, and that height cascades up through the fully un-clamped
    // flex chain to the page itself, where the BROWSER's own scrollbar
    // takes over for whatever doesn't fit above the fold.
    width: "100%",
    boxSizing: "border-box",
  },
  header: {
    display: "flex",
    alignItems: "baseline",
    gap: "12px",
    flexWrap: "wrap",
  },
  headerTitle: {
    fontSize: FONT_SIZE.strong,
    fontWeight: 700,
    letterSpacing: "0.02em",
  },
  headerHint: {
    fontSize: FONT_SIZE.small,
    color: "#8a90a0",
  },
  // The old horizontal `legend`/`legendItem` header-row styles (design note
  // #18/item 5) were removed in design note #19/item 2 along with the row
  // itself -- `legendSwatch`/`legendLabel`/`legendText` below are still
  // shared with the new vertical `MarketRulesLegend` card
  // (`legendColumn*` styles further down).
  // Design note #21/item 4: swatch/label/text all upscaled again -- the
  // zone title (`legendLabel`) and its explanatory description
  // (`legendText`) specifically, per this item's own wording -- now that
  // these render in the narrower vertical `MarketRulesLegend` column
  // (design note #19/item 2) rather than the old wide horizontal row, so
  // there's no width pressure keeping them small. Swatch size bumped
  // alongside them purely for visual proportion against the larger text,
  // not because this item named it directly.
  legendText: {
    fontSize: FONT_SIZE.heading,
    fontWeight: 600,
    color: "#c4c9d4",
    lineHeight: 1.45,
  },
  // Column layout (design note #23(3)(b)): the grid renders first, at the
  // panel's full available width, then `belowGridRow` renders beneath it --
  // replaces the old row layout that sat the grid and a fixed-width side
  // column beside each other.
  boardArea: {
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    // Design note #26: takes the pane, minus the slim tray.
    flex: "1 1 auto",
    minWidth: 0,
  },
  // Wraps just the grid so `ResizeObserver` measures only the space
  // actually available to the price matrix -- see design note #19/item 3.
  // Now the panel's FULL width (design note #23(3)(b) removed the sibling
  // side column that used to share this row), so cells can grow larger
  // before hitting `MAX_CELL_SIZE_PX`. `overflow`/`minHeight` removed by
  // design note #21/item 3 -- see `styles.root`'s own comment; this wrapper
  // now just sizes to the grid's real content height instead of clipping/
  // scrolling it.
  gridWrapper: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "flex-start",
  },
  // ---- Row beneath the matrix -- design note #23(3)(b). Par/IPO Tray and
  // Market Rules Legend now sit side by side (a WIDTH flex basis) instead
  // of stacked in a column beside the grid (the old `sideColumn`'s HEIGHT
  // flex basis). ----
  /** Design note #25: matrix + par track on one row. Wraps on a narrow
   *  window so the track drops below rather than squeezing the grid. */
  /** Design note #26: the MATRIX dominates. `boardArea` already carries
   *  `flex: 1`, but the tray's old `flex: 0 0 340px` claimed a fixed third
   *  of a 1000px pane -- so the chart, which is the entire point of the
   *  tab, got two thirds at best. The tray is now a slim fixed column and
   *  the matrix takes everything else. `minWidth: 0` on the matrix is what
   *  actually lets it shrink-and-grow correctly: without it a flex child
   *  refuses to go below its content width and the tray gets squeezed
   *  instead. */
  boardRow: {
    display: "flex",
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-start",
    gap: "12px",
    width: "100%",
  },
  // ---- Disconnected Par/IPO Tray -- see design notes #10/#17. ----
  parTray: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "12px 14px",
    // Design note #26: SLIM and fixed. `1 1 340px` let it grow into space
    // the matrix should have had; `0 0 168px` pins it to just enough for a
    // price and a row of ticker chips, so everything else goes to the
    // chart. It still wraps to its own row on a genuinely narrow window
    // (`boardRow` has `flexWrap`), which is the right failure mode -- a
    // 168px tray beside a crushed matrix helps nobody.
    flex: "0 0 168px",
    minWidth: "168px",
    backgroundColor: "#161922",
    border: "1.5px solid #2a2e3a",
    borderRadius: "10px",
  },
  // ---- Market Rules Legend -- see design note #19/item 2. ----
  legendColumn: {
    display: "flex",
    flexDirection: "column",
    // Gap widened slightly (14px -> 18px) to give design note #21/item 4's
    // larger zone title/description text room to breathe between entries.
    gap: "18px",
    padding: "20px 22px",
    // Width flex basis now (design note #23(3)(b)) -- see `parTray` above.
    flex: "1 1 340px",
    minWidth: "300px",
    backgroundColor: "#161922",
    border: "1.5px solid #2a2e3a",
    borderRadius: "10px",
  },
  parTrayHeader: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    marginBottom: "8px",
  },
  parTrayTitle: {
    fontSize: FONT_SIZE.heading,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.03em",
    color: "#c8cbd6",
  },
  parTrayHint: {
    fontSize: FONT_SIZE.micro,
    color: "#6f7480",
    lineHeight: 1.35,
  },
  parTrayRow: {
    // Design note #26: compact rows for the narrow column.
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    padding: "11px 16px",
    borderRadius: "8px",
    // Neutral steel-gray, decoupled from both the main chart's gold par
    // fills and its exception-zone tints -- see design note #14.
    backgroundColor: PAR_TRAY_ROW_BG,
    border: `1px solid ${PAR_TRAY_ROW_BORDER}`,
  },
  parTrayPrice: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    // Upsized well past the main chart's own necessarily-small per-cell
    // numbers -- see design note #17: this panel's only job is being an
    // easy-to-read reference sheet.
    fontSize: FONT_SIZE.display,
    fontWeight: 700,
    // Per-row color is overridden inline from `PAR_VALUE_COLORS` so the six
    // standard prices stay visually distinguishable against the now-neutral
    // row background; this is just the fallback.
    color: "#c8cbd6",
  },
  parTrayMarkers: {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
    justifyContent: "flex-end",
  },
  parTrayEmpty: {
    fontSize: FONT_SIZE.strong,
    // Muted steel-gray to match the tray's now-neutral background (was
    // tuned for the old gold row fill -- see design note #14).
    color: "#5a6072",
  },
  parTrayMarkerBadge: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    // Upsized alongside `parTrayPrice` -- see design note #17.
    fontSize: FONT_SIZE.strong,
    fontWeight: 700,
    color: "#ffffff",
    padding: "5px 11px",
    borderRadius: "999px",
    border: "1px solid rgba(0, 0, 0, 0.35)",
    whiteSpace: "nowrap",
  },
  // The grid is sized to `REAL_BOARD_COLUMNS`, which now equals the
  // backend's full `MARKET_MAX_X` range (both sides adopted the real
  // board's true 19-column width in this refactor -- see design note #1).
  // An occupant token at a column past this still renders via an implicit
  // CSS grid track rather than being clipped.
  grid: {
    display: "grid",
    gridTemplateColumns: `repeat(${REAL_BOARD_COLUMNS}, ${CELL_SIZE_PX}px)`,
    gridAutoColumns: `${CELL_SIZE_PX}px`,
    gridAutoRows: `${CELL_SIZE_PX}px`,
    gap: "2px",
    overflow: "visible",
  },
  cell: {
    position: "relative",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "flex-start",
    backgroundColor: "#161922",
    // See design note #7 -- bright enough that adjacent cells' shared edges
    // read as a clear boundary/movement-path grid.
    border: "1px solid #3a4152",
    borderRadius: "3px",
    // `hidden`, not `visible` -- see design note #17: a par/zone cell's
    // gradient `background` (`PAR_VALUE_GRADIENTS`/`ZONE_GRADIENTS`) must
    // never bleed past its own border into the grid's `gap` or a
    // neighboring cell. This is safe to flip from the prior `visible`
    // specifically because live company tokens are NOT nested inside a
    // `.cell` element at all -- they're rendered as their own independent
    // sibling `tokenWrapper` grid items (design note #5), so a deep token
    // stack still spills visibly over neighboring cells exactly as before;
    // only this element's own background/content is now clipped to its box.
    overflow: "hidden",
    // Explicit stacking layer -- design note #23(1): below `parGroupFrame`
    // (zIndex 6) so that overlay's border always paints over every cell's
    // own border rather than the reverse.
    zIndex: 1,
  },
  // Gold Par Box grouping frame -- see design note #18/item 4. An
  // independent grid item (positioned via inline `gridColumn`/`gridRow` at
  // the call site, spanning all six par cells' outer bounding box), not a
  // `.cell` modifier -- so its thick border traces the group's TRUE outer
  // perimeter (including the internal cell gaps, which a spanning grid
  // item's box always includes) rather than six separate per-cell borders
  // that would show a visible seam at every gap.
  // Design note #22/item 1: recolored from `#ffd54a` to the explicitly
  // requested `#EAB308` gold.
  parGroupFrame: {
    border: "4px solid #EAB308",
    borderRadius: "6px",
    boxSizing: "border-box",
    pointerEvents: "none",
    boxShadow: "0 0 10px rgba(234, 179, 8, 0.45)",
    // Explicit positioned stacking layer -- design note #23(1). Without
    // `position` set, this element was "non-positioned" and painted BEFORE
    // every price cell (which sets `position: relative`) regardless of DOM
    // order, per CSS2.1's painting-order rules -- the actual cause of the
    // frame appearing as six separate per-cell segments instead of one
    // continuous rectangle. `zIndex: 6` sits above `styles.cell`'s `1` and
    // below `styles.tokenWrapper`'s `10`, so tokens still render in front
    // of the frame exactly as before.
    position: "relative",
    zIndex: 6,
  },
  // Color promoted from the former `PAR_COLUMN_NEUTRAL_TEXT_COLOR` (design
  // note #20/item 1) -- brighter/higher-contrast than the prior dim
  // `#6f7480`, now the single text color for every `"Normal"`-tagged cell
  // (including the six par-ladder cells, which no longer get their own
  // separate `priceTextPar` dark-on-gold color -- that style is removed).
  /* Design note #43: absolutely positioned in the cell's top-right corner,
     so the arrow never displaces the price text -- which is dynamically
     sized off the measured cell and would reflow if a sibling took width.
     `styles.cell` is already `position: relative` for the par frame. */
  cliffArrow: {
    position: "absolute",
    top: "1px",
    right: "2px",
    lineHeight: 1,
    fontSize: "9px",
    pointerEvents: "none",
    textShadow: "0 0 2px rgba(0,0,0,0.8)",
  },
  cliffArrowUp: { color: "#4ade80" },
  cliffArrowDown: { color: "#f87171" },
  priceText: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "9px",
    color: "#c8ccd6",
    padding: "2px 3px",
  },
  parBadge: {
    position: "absolute",
    right: "2px",
    bottom: "1px",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "6px",
    fontWeight: 700,
    letterSpacing: "0.03em",
    color: "#1a1408",
    opacity: 0.75,
  },
  gameEndBadge: {
    position: "absolute",
    left: "2px",
    bottom: "1px",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "6px",
    fontWeight: 700,
    letterSpacing: "0.03em",
    color: "#ff6b5e",
  },
  tokenWrapper: {
    position: "relative",
    overflow: "visible",
    pointerEvents: "none",
    // Explicit stacking layer -- design note #23(1): above `parGroupFrame`
    // (zIndex 6), so live company tokens keep rendering in front of the par
    // frame exactly as before that fix.
    zIndex: 10,
  },
  // Station-token circle -- design note #23(3)(a). Fixed diameter (set
  // inline per-token from `deriveTokenDiameterPx`) with the ticker label
  // flex-centered inside, replacing the old auto-width text pill --
  // matching the physical 1830 game's own circular station-token pieces.
  tokenBadge: {
    position: "absolute",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontWeight: 700,
    color: "#ffffff",
    borderRadius: "50%",
    border: "2px solid rgba(0, 0, 0, 0.4)",
    boxShadow: "0 2px 4px rgba(0, 0, 0, 0.55)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    lineHeight: 1,
    textAlign: "center",
    pointerEvents: "auto",
  },
};
