// frontend/src/App.tsx
//
// Milestone 4: the main UI layout wrapper -- wires the Web3 Wallet + Session
// Key layer (Milestones 1-2: WalletContext.tsx / sessionKey.ts /
// GameSessionContext.tsx) and the 2D Canvas Graphics Engine (Milestone 3:
// HexGridRenderer.tsx) into one screen. This pass flattens the previous
// two-level tab dashboard into exactly four top-level tabs, consolidates the
// Chatbox/Action Log into one left-pinned Activity Feed, and adds a
// Contextual Top Action Bar that swaps its buttons based on the room's live
// round type.
//
// Design notes / scope, since this is a layout-and-wiring pass, not a full
// live-chain integration:
// 1. **No game/room selection UI yet.** Nothing in the frontend so far
//    creates or joins a room (`CreateGameRoom`/`JoinGameRoom` are
//    Keplr-signed, real-JUNO-moving messages -- a future milestone's own
//    screen, not this one). `MOCK_GAME_ID` below stands in for "the
//    currently open room" everywhere a `game_id` is required, purely so
//    this screen's buttons and every live query have something concrete to
//    target. Swap it for real room state once that flow exists.
// 2. **The map/stock panes still render mock data, not a live `GetMapGrid`/
//    `GetMarketGrid` query.** Per this milestone's own original request,
//    `MOCK_MAP_GRID`/`MOCK_MARKET_GRID` are small, hand-built responses so
//    `HexGridRenderer`/`StockMarketRenderer` can be visually verified
//    end-to-end before any query-wiring work exists for THOSE two queries
//    specifically. `GetGameState` (design note #7 below) IS wired live,
//    unlike those two -- an intentionally uneven state of wiring across
//    this screen's three queries, not an oversight.
// 3. *(superseded by design note #7 -- see there for the live
//    `useGameStatePolling` this note used to describe a one-shot version
//    of.)*
// 4. **Mock action parameters, not mock plumbing.** There's still no
//    stock-picker/revenue-input UI, so every gameplay button below that
//    needs a `protocol_id`/`par_value`/`percentage`/`revenue_amount`
//    parameter uses a hardcoded constant, clearly labeled "(mock)" in its
//    own button text -- but every one of them calls the exact same
//    `execGameplay` -> `execViaSessionKey` -> `authz.MsgExec` pipeline
//    `PassTurn` does. Clicking any of them is how this screen visually
//    proves that background pipeline actually fires, via the Activity
//    Feed's Action Log (design note #6).
// 5. *(superseded by design note #6 -- the Action Log is no longer a
//    standalone panel; see there for where it lives now.)*
// 6. **Consolidated left-side Activity Feed (item 4 of this pass).**
//    Chatbox and the Action Log used to be two separate panels in a row
//    above the canvas. `ActivityFeed` below merges them into ONE bordered
//    container -- chat on top, the automatic transaction trail underneath,
//    sharing one scroll region -- pinned to the far left edge of the
//    workspace, ahead of the canvas column, on BOTH the Rail Map and Stock
//    Market tabs (the two tabs that actually have a canvas workspace;
//    Financial Ledger/Rules Reference are full-width reference screens with
//    no canvas, so they don't carry this feed). This also supersedes the
//    previous pass's separate `Sidebar` "Gameplay Actions" column -- those
//    buttons now live in the Contextual Top Action Bar (design note #8)
//    instead, so the left edge is single-purpose (activity/history), not
//    split between two different sidebars.
// 7. **One shared live `GetGameState` poll, not several one-off queries.**
//    `utils/gameState.ts`'s `useGameStatePolling` is a properly typed,
//    interval-driven (default 6s) poll of the FULL `GameStateResponse` --
//    the VGP balance display, the Chatbox's turn-alert comparison, the
//    Contextual Sub-Panel, the Contextual Top Action Bar's round-type
//    switch (design note #8), the Financial Ledger tab, and
//    `HexGridRenderer`'s `currentEra` prop all derive from this ONE shared
//    result. Every action that mutates game state calls the poll's own
//    `refreshGameState()` afterward.
// 8. **Contextual Top Action Bar (item 5 of this pass).**
//    `ContextualActionBar` sits directly above the canvas, on both the Rail
//    Map and Stock Market tabs, and swaps its entire button set based on
//    the live `gameState.current_round_type`: a Stock Round shows
//    "Buy Share (mock)" / "Sell Shares (mock)" / "Pass Turn"; an Operating
//    Round shows "Place Station Token" / "Run Trains (mock)" /
//    "Declare Dividends (mock)" / "Buy Train (mock)". Each maps to a real
//    `GameplayExecuteMsg` variant already in `sessionKey.ts`'s allow-list
//    (`BuyStock`/`SellStock`/`PassTurn`/`ExecuteOperatingRound`/
//    `DeclareDividends`/`BuyHardwareFromPool`) EXCEPT "Place Station Token":
//    there is no standalone "place a station" message distinct from
//    `LayTile`, and `LayTile` itself needs a specific `(q, r)` hex the
//    player has clicked -- it cannot be fired from a single generic button
//    the way the others can. That button is therefore deliberately
//    non-dispatching: it logs a short informational Action Log entry
//    pointing the player at the Rail Map canvas's own existing click ->
//    `TileSelectionPopup` flow, rather than fabricating a fake dispatch or
//    silently doing nothing. "Undo Last Action" (a real, already-wired
//    message with no natural home in either round-type's button set) stays
//    available as a small always-visible utility button on the same bar,
//    independent of round type.
// 9. **Four flattened top-level tabs (item 3 of this pass).** The previous
//    two-level "Game Board (Rail Map/Stock Market sub-tabs) / Financial
//    Ledger / Rules Reference" structure is now exactly four SIBLING tabs:
//    "Rail Map", "Stock Market", "Financial Ledger", "Rules Reference" --
//    `MainTab`/`MainTabBar` below. The Dashboard Control Bar and its
//    wallet/session controls stay visible across all four. The Activity
//    Feed / Contextual Top Action Bar / canvas / Contextual Sub-Panel are
//    scoped to whichever of "Rail Map"/"Stock Market" is active (both share
//    the same workspace layout, design note #6/#8); Financial Ledger and
//    Rules Reference keep their own full-width, canvas-free layouts,
//    unchanged from the previous pass.
// 10. **Step-by-Step Action Sub-Phases (item 2 of this pass).** Design note
//    #8's Operating Round button set used to show all four OR actions at
//    once, all the time. `orSubPhase` (`OperatingSubPhase`) now walks the
//    player through a corporation's turn in the real 1830 legal
//    chronological order instead: Track -> Tokens -> Dividends -> Hardware.
//    Purely client-side UI sequencing (see `OperatingSubPhase`'s own doc
//    comment for why) -- reset to "Track" by a `useEffect` keyed on
//    `gameState.active_corporation_index`/`current_round_type` so a new
//    corporation's turn (or leaving the Operating Round entirely) always
//    starts the sequence over. Each phase's buttons: Track shows "Skip
//    Track Lay" (laying an actual tile is still the existing canvas-click
//    flow, design note #8); Tokens shows the existing "Place Station Token"
//    hint alongside a new "Skip Tokens"; Dividends shows the existing "Run
//    Trains (mock)" (kept here, not dropped, since real revenue must be run
//    before dividends can be declared against it -- see that button's own
//    inline comment) plus explicit "Pay Dividends"/"Withhold Revenue"
//    buttons (both the same real `DeclareDividends` message, differing only
//    in its `distribute` field); Hardware shows the `MOCK_TRAIN_CATALOG`
//    marketplace tray (display/selection only -- `BuyHardwareFromPool` has
//    no per-model parameter yet) plus "Buy Train (mock)" and "End Turn"
//    (`PassTurn` -- the same message `msg.rs` documents as the one that
//    also advances an Operating Round to the next corporation).
// 11. **Manual Route Point UI.** A new "Select Route Points" toggle sits on
//    the Contextual Top Action Bar, always visible (independent of round
//    type/OR sub-phase, like "Undo Last Action" -- design note #8), and only
//    meaningful on the Rail Map tab. HONEST LIMITATION, read before relying
//    on this: this contract has NO `ExecuteMsg`/`QueryMsg` that accepts or
//    validates a caller-submitted path at all -- `operations.rs`'s Operating
//    Round revenue action always computes each corporation's route
//    automatically and exhaustively via `pathfinding::trace_best_route`'s
//    own breadth-first search (see `msg.rs`'s doc comment on that flow and
//    `pathfinding.rs`'s module doc comment #3); there is no "submit this
//    exact path" message for `LayTile`'s sibling gameplay actions to call,
//    and building one would be a genuine new contract feature, not a
//    frontend wiring gap. So "verify against our contract route
//    constraints" cannot mean a real round-trip query here -- what this
//    toggle actually does is a client-side, honestly-scoped SCOUTING aid:
//    while active, `HexGridRenderer`'s existing `onHexClick` callback
//    (already a plain prop on that component, previously unused by this
//    file -- see its own doc comment) is wired to `handleRouteHexClick`
//    instead of the LayTile click-interceptor (`queryClient`/
//    `contractAddress`/`gameId`/`protocolId` are all omitted from
//    `<HexGridRenderer>` while `routeSelectMode` is on, which per that
//    component's own design note #7 fully disables its query-firing click
//    interceptor, leaving `onHexClick` as the only click consumer). Each
//    click appends `{q, r, hexLabel}` to `routePoints`; clicking the most
//    recently added point again removes it (a quick one-step undo);
//    `axialHexDistance` (a plain, standard axial-coordinate hex-distance
//    formula, independent of this file needing any of HexGridRenderer's own
//    internal pixel/rotation helpers) rejects a new point that isn't a
//    direct neighbor of the current last point, with an inline
//    `routeFeedback` message explaining why -- so the resulting path array
//    is at least a genuinely connected hex chain. The one REAL constraint
//    this can check against already-live app state: `routeHopCount`
//    (`routePoints.length - 1`) is compared against the currently
//    `selectedHardwareModel`'s own `maxDistance` (design note #10's
//    `MOCK_TRAIN_CATALOG`, itself a mirror of a real `COMPANY_HARDWARE`
//    train's route-length limit), flagging `routeExceedsMaxDistance` when
//    the manually-built path is longer than that train could legally run.
//    Everything else a true validation would need -- whether each hop
//    actually follows laid track with a connecting edge, whether the path
//    starts/ends at the corporation's own token, whether it's actually the
//    highest-value route -- is exactly what `trace_best_route` computes
//    on-chain and is deliberately NOT reimplemented here, rather than
//    silently faking a "verified" result this contract has no way to back.
// 12. **Global Dashboard Text & Layout Upscaling (final visual theme pass,
//    item 5).** A pure typography/spacing pass across every surrounding
//    control panel -- no new components, no behavior changes -- so the
//    dashboard fills widescreen real estate as comfortably as the map/stock
//    canvases already do (`HexGridRenderer.tsx`/`StockMarketRenderer.tsx`'s
//    own viewport-maximization passes). Six panels, each upscaled roughly
//    25-60% past its original small-print sizing: the Upper Brand Header
//    (`styles.dashboard`/`dashboardBrand`/`statusBadge`/`addressIndicator`/
//    `vgpBalance`/`button` -- the "18Cosmos" title row, wallet/session
//    badges, and Connect/Disconnect/Initialize buttons); the Primary
//    Navigation Tabs (`styles.mainTabBar`/`mainTabButton`); the left-side
//    Activity Feed's own Action Log half (`styles.activityFeed`/
//    `actionLogPanel`/`actionLog*`, widened 300px -> 380px to give the
//    larger text room -- Chatbox.tsx's own design note #4 covers its chat
//    half); the Contextual Top Action Bar (`styles.actionBar`/
//    `actionBarButton`/`hardwareTrayCard`/`routePanel*` -- every button/
//    label inside the dynamic header action layout, not just the top-level
//    round-type buttons); and the Stock Market Rule Legend
//    (`StockMarketRenderer.tsx`'s own `styles.legend*`, that file's own
//    design note #18). The Round Detail Footer is `ContextualSubPanel.tsx`
//    -- the "automated contextual block underneath the board" this file
//    renders as `<ContextualSubPanel>` -- see that file's own design note
//    #5 for its upscaling. Deliberately NOT touched: canvas-internal text
//    (`HexGridRenderer`/`StockMarketRenderer`'s own per-cell/per-hex fonts
//    already have their own dedicated dynamic-scaling systems from earlier
//    passes) and `RulesReference.tsx`/`FinancialLedger.tsx` (full-width
//    reference screens outside this item's named list of six panels).
// 13. **Page-Level Scrolling & Height Un-Constraint (item 1 of this pass).**
//    Every ancestor of the map/stock canvas used to cascade a HARD height
//    ceiling down from `styles.appRoot`'s `height: "100vh"`, through
//    `mainRow`'s `flex: 1` / `minHeight: 0`, down to `canvasPane`'s
//    `overflow: "auto"` and `boardPane`'s own `overflow: "auto"` -- so no
//    matter how large the actual board content was, it was always squeezed
//    into whatever pixel height the browser viewport happened to have, with
//    any overflow trapped behind that pane's own tiny internal scrollbar
//    instead of the page's. `appRoot`'s `height: "100vh"` is now
//    `minHeight: "100vh"` (still fills at least a full viewport on a short
//    page, but can grow taller to fit real content instead of clipping it),
//    and `canvasPane`/`boardPane` both drop `overflow: "auto"` outright (see
//    each style's own comment for exactly what replaced it). With no
//    ancestor left imposing a hard height, the whole column's height is now
//    simply the sum of its own content's natural sizes -- exactly what
//    `HexGridRenderer.tsx`'s own design note #27 relies on to size the
//    canvas at its true maximum proportional scale instead of being
//    shrink-to-fit -- and the BROWSER's own page scrollbar (not any inner
//    pane's) is what carries a player down to whatever doesn't fit above the
//    fold. The left-side Activity Feed's own `overflowY: "auto"` (design
//    note #6) and the Action Log's own `overflowY: "auto"` (design note #7)
//    are both deliberately left untouched -- those are independent,
//    genuinely-scrollable chat/log HISTORY lists, not a viewport clamped
//    around the board, so they're outside this item's "surrounding our rail
//    map canvas" scope.
// 14. **Buy Private Company Action Tray (Private Company lifecycle pass).**
//    A new tray in the Hardware sub-phase (design note #10/item 2) alongside
//    the existing Buy Train/End Turn buttons -- the Phase-Gated Corporate
//    Purchase Protocol (`trading.rs` module doc comment #17) is itself a
//    corporate treasury purchase, the same category of action as buying
//    Hardware, so it's grouped into that same step rather than getting a
//    fifth top-level sub-phase of its own. Dispatches the real
//    `BuyPrivateCompany` message (now in `sessionKey.ts`'s
//    `GAMEPLAY_MESSAGE_KEYS` allow-list) against `MOCK_LAY_TILE_PROTOCOL_ID`
//    (B&O), the same stand-in "currently operating corporation" every other
//    OR action on this bar already uses (design note #1). The dropdown lists
//    `playerSellablePrivateCompanies(activePlayerAddress, gameState)` --
//    privates `activePlayerAddress` still owns AND aren't `closed` (a closed
//    private permanently rejects the real message, so it's excluded rather
//    than offered as a guaranteed-failing option). The price slider is
//    bounded to the contract's own 50%-200%-of-face-value legal range,
//    computed client-side from the selected private's `cost` (floor
//    `Math.ceil(cost / 2)`, ceiling `cost * 2`) -- purely a UX guardrail,
//    since `trading::execute_buy_private_company` re-enforces the exact same
//    bound on-chain regardless. The whole tray is hidden outside Phase 3+
//    (`current_global_era !== "Yellow"`), mirroring the contract's own
//    `PrivatePurchaseLockedBeforePhase3` gate, and hidden entirely if
//    `activePlayerAddress` currently has nothing left to sell.

// 15. **Restored Boston/New York Nameplates (`MOCK_MAP_GRID` fix).** Bug:
//    "Boston" and "New York"'s preprinted nameplates never drew, even on a
//    freshly loaded board before any tile had been laid. The suppression
//    logic itself, `HexGridRenderer.tsx`'s `hexHasLaidTile(mapGrid, q, r)`,
//    is correct and purely `mapGrid.tiles`-membership-based (`tiles.some(t
//    => t.q === q && t.r === r)`) -- it has no terrain- or catalog-based
//    logic and does not special-case `BostonHub`/`NewYorkHub` at all. The
//    real bug was upstream, in this file: `MOCK_MAP_GRID` (design note #2,
//    this file's own hand-built stand-in for a live `GetMapGrid` query)
//    used to pre-seed all three landmark hexes (New York, Boston,
//    Baltimore) with a `tile_id: 10` entry each, reasoning at the time
//    that this was "accurate to the physical board's own pre-printed
//    track." That reasoning conflated two different things: what's
//    physically pre-printed on a real 1830 board, versus what this
//    codebase's own `MAP_GRID`/`hexHasLaidTile` semantics mean, which is
//    strictly narrower -- confirmed by an audit of every `MAP_GRID.save`
//    call site in the backend (`hexmap.rs`), which is called ONLY from
//    inside `execute_lay_tile`. A real, freshly created game's `MAP_GRID`
//    is genuinely empty at all three landmark hexes until a player's first
//    explicit `LayTile` message there -- so `MOCK_MAP_GRID` pre-seeding
//    them was actively less accurate to real chain state than an empty
//    array would have been, and it caused every nameplate-suppression
//    check in `HexGridRenderer.tsx` to treat the landmarks as permanently
//    tiled from the moment the app loaded, hiding their names forever
//    (not just briefly, since nothing in this mock/demo build ever removes
//    a `MOCK_MAP_GRID` entry).
//
//    Fix: `MOCK_MAP_GRID.tiles` is now `[]`. This is safe -- nothing about
//    a landmark's own visual rendering actually depended on `mapGrid.tiles`
//    membership in the first place. `drawLandmarkTrack` draws each
//    landmark's authentic pre-printed track completely unconditionally (it
//    loops `LANDMARK_HEXES` directly, never consults `mapGrid` at all), and
//    the static background fill pass likewise loops `STATIC_BOARD_HEXES`
//    unconditionally and already has each landmark's `printedColor:
//    "Yellow"` baked in. The only thing that was ever gated on
//    `mapGrid.tiles` membership was the nameplate-suppression logic itself
//    -- which is exactly the thing this fix un-breaks. No other on-screen
//    element changes as a result of this edit.
//
// 16. **Activity Log Auto-Scroll & Full-Height Flex (Left Panel refactor
//    pass).** Two fixes to `ActionLogPanel`, scoped to layout/behavior only
//    -- no map/tile/contract changes:
//    (1) `styles.actionLog` (the scrollable entry list) gains `flex: 1` +
//    `minHeight: 0` so it actually claims the vertical space
//    `actionLogPanel` has available (flex column layouts need an explicit
//    `minHeight: 0` on a flexed child, or that child's content-based
//    min-height silently overrides the flex-basis and defeats internal
//    scrolling -- the classic flexbox gotcha). `styles.activityFeed` (the
//    outer `<aside>`) gets the same `minHeight: 0` treatment for the same
//    reason, one level up, so its two children (`Chatbox` and
//    `ActionLogPanel`) each get a genuine bounded height to scroll inside
//    of, instead of the whole aside just growing tall and relying on the
//    page/aside-level scrollbar.
//    (2) Auto-scroll: `entries` are prepended (`setActionLog((log) => [new,
//    ...log])`, confirmed at every call site in this file), so the NEWEST
//    entry is always array index 0 -- rendered at the TOP of the list, not
//    the bottom. A `useRef`+`useEffect` keyed on `actionLog.length` sets
//    `container.scrollTop = 0` whenever a new entry arrives, so a player
//    who has scrolled down into older history is snapped back up to see
//    the newest event -- deliberately the opposite direction from a
//    typical chat log, because this list's insertion order is reversed
//    from Chatbox's (see that component's own design note #5 for its
//    scroll-to-bottom counterpart, which is correct there because chat
//    messages are appended, not prepended).
//    (3) `styles.actionLogDetail`'s `wordBreak: "break-all"` (needed for
//    unbroken tx-hash strings) was also breaking ordinary readable detail
//    text (e.g. "No tile laid this turn -- advancing to the Tokens phase.")
//    mid-word, which reads as sloppy for the plain-English entries this
//    item asked to verify render "cleanly formatted." Switched to
//    `wordBreak: "break-word"` + `overflowWrap: "anywhere"`, which still
//    force-wraps a single unbroken tx-hash token that has no natural break
//    point, but prefers breaking at actual word boundaries first -- so
//    readable sentences wrap like prose while hashes still never overflow
//    the panel.
//
// 17. **"Game Ledger" Tab Rename & Rules Reference Wiring (Ledger/Rules
//    overhaul pass).** Two small pieces of `App.tsx`-side wiring for this
//    pass's changes elsewhere:
//    (1) `MainTabBar`'s `"ledger"` tab label changed from "Financial
//    Ledger" to "Game Ledger" -- display text only, see
//    `FinancialLedger.tsx`'s own design note #5 for why the source
//    module/component/export name is deliberately left unchanged.
//    (2) `<RulesReference />`'s render call site now passes
//    `roundType={gameState?.current_round_type ?? null}` and
//    `operatingSubPhase={orSubPhase}` -- both values this file already
//    computes for its own Contextual Top Action Bar (design note #8),
//    simply threaded through as two new OPTIONAL props (same
//    "omit to degrade gracefully" convention as `FinancialLedger.tsx`'s own
//    `queryClient`/`contractAddress`/`gameId`, design note #4 there) so
//    that tab's new "Current Round Quick Reference" section can genuinely
//    reflect the room's live round/sub-phase instead of only ever showing
//    its static all-three-rounds fallback. See `RulesReference.tsx`'s own
//    design notes for what it does with these two values.
//
// 18. **Full-Width Dashboard Layout, Compact Top Ticker, Combined Feed
//    Overlay, and Active Turn Notifications (this pass).** SUPERSEDES
//    design note #6's "Consolidated left-side Activity Feed" entirely --
//    Chatbox + ActionLogPanel no longer render as an always-visible,
//    fixed-width (`380px`) left sidebar; that sidebar is REMOVED from the
//    dashboard grid layout outright. Four pieces:
//    (1) **100% full-width main canvas.** With the left sidebar gone,
//    `mainRow`'s old flex ROW (sidebar + `canvasPane`) collapses to just
//    `canvasPane` rendered directly -- the Rail Map canvas, Stock Market
//    matrix, Game Ledger, and Rules Reference tabs (none of which this
//    file's own `canvasPane`/`boardPane` styles ever constrained to less
//    than their container's width, even before this pass) now genuinely
//    claim 100% of the available viewport width with nothing competing for
//    it. No change to `HexGridRenderer.tsx`/`StockMarketRenderer.tsx`
//    themselves -- both already measure and fill whatever width their
//    parent pane grants them (their own prior viewport-maximization
//    passes), so removing the sidebar is enough on its own.
//    (2) **Compact Top Ticker Bar** (`TopTicker.tsx`) -- a thin, single-line
//    bar rendered directly below `DashboardControlBar`, visible across
//    every tab (not scoped to the Rail Map/Stock Market workspace the old
//    sidebar was). Previews the single most recent item from a NEW
//    chronologically merged Chat+Action Log timeline (`utils/feed.ts`'s
//    `mergeFeedItems` -- see that file's own design notes for exactly how
//    the merge/sort/icon-matching works), shows an unread-count badge
//    while collapsed, and opens/closes `FeedOverlay.tsx` on click.
//    (3) **Combined Feed Overlay** (`FeedOverlay.tsx`) -- a modal/dropdown,
//    always mounted (gated by its own `isOpen` prop, matching this file's
//    existing `TileSelectionPopup` convention), replacing the old
//    always-visible sidebar's Chat+Action Log panels with ALL/CHAT/LOG
//    filter pills over the SAME merged timeline, chat entries styled with a
//    per-author brand color tag, log entries as compact status-colored
//    badge strips, and the chat composer anchored at the overlay's own
//    bottom. `chatMessages` state (previously owned entirely inside
//    `Chatbox.tsx`) moves up into this file so it can be merged with
//    `actionLog` -- `Chatbox.tsx` itself is no longer rendered directly
//    (see that file's own design note #6 for what's still reused from it:
//    the `ChatMessage` type and `truncateChatAddress` helper). Every
//    `ActionLogEntry` construction site in this file
//    (`handleTileDispatched`/`runGameplayAction`/`logInfo`) gains one new
//    field, `timestampMs` (`Date.now()` at construction) -- needed so the
//    merge can sort chat and log entries against each other by REAL time,
//    not just each array's own internal insertion order (Action Log
//    prepends, Chat appends -- see each file's own prior design notes).
//    `ActionLogEntry`/`ActionLogStatus` themselves moved to `utils/feed.ts`
//    (see that file's own design note #1) so both this file and the new
//    feed components share one definition.
//    (4) **Active Player Turn Notifications.** `isMyTurn` (the same
//    `connectedWalletAddress === activePlayerAddress` comparison
//    `Chatbox.tsx` used to make internally, design note #2 there --
//    computed once here now that Chatbox itself isn't rendered) drives two
//    independent effects: `utils/turnAlert.ts`'s `useDocumentTitleFlash`
//    hook alternates `document.title` every 1000ms between "🚨 YOUR TURN! -
//    18Cosmos" and "18Cosmos - Juno Edition" while true, restoring the
//    normal title immediately once it goes false (see that file's own
//    design notes for the exact interval/restore contract); and a subtle
//    repeating CSS pulse glow (`app-turn-pulse-glow`, a `<style>`-tag
//    keyframes injection using the same escape-hatch convention
//    `Chatbox.tsx`'s own design note #2 already established for this
//    codebase's plain-inline-style convention) applies to both a
//    `position: fixed`, `pointerEvents: "none"` viewport-margin overlay
//    (`styles.turnPulseOverlay`, always mounted, rendered only while
//    `isMyTurn`) and `ContextualActionBar`'s own outer wrapper (a new
//    `isMyTurn` prop on that component, applied via
//    `styles.actionBarTurnPulse`) -- covering both "around the top action
//    bar" and "viewport margin" from this item's own request in one shared
//    animation rather than two independently-tuned ones.
//
// 19. **Top Ticker Refinement: Prominent Sizing, Inline Quick-Chat, and
//    Notification Settings (this pass).** Three pieces, layered on top of
//    design note #18's dashboard refactor without changing its state
//    ownership:
//    (1) **Prominent Top Ticker sizing/typography** -- `TopTicker.tsx`'s
//    own design note #4: taller bar, bigger `#F8FAFC` medium-weight text,
//    and the unread badge/expand hint scaled up alongside it. No App.tsx
//    change needed for this item -- purely internal to that component.
//    (2) **Inline Quick-Chat Box** (`InlineQuickChat.tsx`) -- a new,
//    always-mounted bar directly below `TopTicker`, letting a player send a
//    chat message with zero friction (no "Expand" click, no modal) via a
//    compact input + Send button, Enter to submit. Reuses the exact same
//    `chatDraft`/`setChatDraft`/`handleSendChatMessage` this file already
//    threads into `FeedOverlay`'s own composer -- deliberately ONE shared
//    draft (see `InlineQuickChat.tsx`'s own design note #1), so typing
//    started in one composer is still there if a player switches to the
//    other.
//    (3) **Notification Settings inside the Feed Overlay** -- historical,
//    REMOVED by design note #21 below. At the time of this pass,
//    `titleFlashEnabled`/`pulseGlowEnabled` (both default `true`) gated
//    design note #18/item 4's two turn-alert channels via
//    `isMyTurn && titleFlashEnabled` and `turnPulseActive = isMyTurn &&
//    pulseGlowEnabled`. Both settings and the gating they did are gone --
//    see design note #21 for why (turn alerts are now mandatory, with no
//    per-player opt-out anywhere in the app).
//
// 20. **In-Place Accordion Panel, replacing the Feed Overlay modal (this
//    pass).** `FeedOverlay.tsx` (design note #18/item 3's floating
//    modal/backdrop) is no longer imported or rendered anywhere in this
//    file -- its ALL/CHAT/LOG filtering, entry rendering, and Notification
//    Settings toggles moved into `TopTicker.tsx` and `InlineQuickChat.tsx`
//    directly (see those files' own design notes), so the whole feed now
//    lives in-place rather than in a floating panel:
//    (1) **`isTickerExpanded`** (renamed from `feedOpen`, same boolean
//    role) now controls `TopTicker.tsx`'s in-place accordion body instead
//    of `FeedOverlay`'s `isOpen`/mount-unmount. `handleToggleTickerExpand`
//    (renamed from `handleToggleFeed`) is the only toggle needed --
//    `handleCloseFeed` is gone entirely, since there's no backdrop/×
//    button to close anymore, just the same header chevron toggling both
//    directions.
//    (2) **`filteredFeedItems`** is new -- `feedItems` (the full merged,
//    unfiltered timeline from `mergeFeedItems`) filtered by `feedFilter`,
//    the exact same filter state from design note #18/item 3 (now driven
//    by the pills `InlineQuickChat.tsx` renders instead of the old modal).
//    `latestFeedItem` and `unreadFeedCount` are now derived from this
//    FILTERED array rather than the unfiltered one, so switching filters
//    "instantly filters both the single-line preview and the 7-line
//    expanded history view" (this pass's own requirement) -- both
//    `TopTicker`'s `latestItem` and `items` props come from this one
//    filtered source, and `InlineQuickChat`'s pills are what drive it.
//    (3) **Seamless tab docking.** `styles.mainTabButtonActive` and
//    `styles.mainTabBar` now share the exact dark-slate palette this pass
//    requested (`#1E293B` active tab / `#0F172A` bar background) with
//    `TopTicker.tsx`'s own header (`#1E293B`) and body (`#0F172A`) --
//    the active tab's background is now IDENTICAL to the ticker header
//    directly beneath it, with `borderColor` matching too, so there is no
//    color seam or border line where the active tab meets the ticker.
//
// 21. **Mandatory Turn Alerts -- Notification Settings removed entirely
//    (this pass).** Direct feedback: players must not be able to opt out
//    of turn alerts. `titleFlashEnabled`/`pulseGlowEnabled` state, their
//    `handleToggleTitleFlash`/`handleTogglePulseGlow` callbacks, and the
//    two toggle switches `TopTicker.tsx` used to render in its expanded
//    body (that file's own former design note #6) are all deleted -- not
//    disabled, not defaulted differently, gone. Both turn-alert channels
//    now key DIRECTLY off `isMyTurn` with no intermediate gated value:
//    `useDocumentTitleFlash(isMyTurn)` (was `isMyTurn && titleFlashEnabled`)
//    and bare `isMyTurn` at both of the pulse's call sites (the fixed
//    viewport overlay's render guard, and `ContextualActionBar`'s own
//    `isMyTurn` prop -- `turnPulseActive` is gone, there is nothing left to
//    gate). Because both channels are simple boolean expressions of
//    `isMyTurn` alone, "alerts stop as soon as `isMyTurn` becomes `false`"
//    (this pass's own requirement) falls out of the existing `useEffect`
//    cleanup in `utils/turnAlert.ts` and the plain `{isMyTurn && ...}`
//    JSX guard -- neither needed to change to satisfy it, just to lose
//    their gating operand. `TopTicker.tsx`'s expanded body is now JUST the
//    scrollable history list (that file's own updated design note #6) --
//    no settings/checkbox/toggle UI survives anywhere in the ticker
//    module.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { WalletProvider, useWallet, CONTRACT_ADDRESS } from "./context/WalletContext";
import { chainConfigError, formatNativeAmount, NATIVE_DENOM_DISPLAY } from "./config";
import { GameSessionProvider, useGameSession } from "./context/GameSessionContext";
import HexGridRenderer, {
  type RouteOverlay,
  type MapGridResponse,
  type HexClickQueryState,
} from "./components/HexGridRenderer";
import StockMarketRenderer, {
  type MarketGridResponse,
} from "./components/StockMarketRenderer";
import TileSelectionPopup, {
  type TileSelectionPopupProps,
} from "./components/TileSelectionPopup";
import TopTicker from "./components/TopTicker";
import InlineQuickChat from "./components/InlineQuickChat";
import ContextualSubPanel from "./components/ContextualSubPanel";
import FinancialLedger from "./components/FinancialLedger";
import RulesReference from "./components/RulesReference";
import WaterfallAuctionDashboard from "./components/WaterfallAuctionDashboard";
import StockRoundPanel from "./components/StockRoundPanel";
import {
  useGameStatePolling,
  useWaterfallStatePolling,
  playerSellablePrivateCompanies,
  type RoundType,
  type PrivateCompanyState,
  type TileColor,
} from "./utils/gameState";
import {
  mergeFeedItems,
  truncateChatAddress,
  type ActionLogEntry,
  type ChatMessage,
  type FeedFilter,
} from "./utils/feed";
import { useDocumentTitleFlash } from "./utils/turnAlert";
import type { GameplayExecuteMsg } from "./utils/sessionKey";

/* ------------------------------------------------------------------ */
/* Placeholder room state -- see design note #1                       */
/* ------------------------------------------------------------------ */

const MOCK_GAME_ID = 1;
const MOCK_BUY_STOCK_PROTOCOL_ID = 1; // PRR, per public_company::CORE_PUBLIC_COMPANIES
const MOCK_BUY_STOCK_PAR_VALUE = "100"; // top of the standard 1830 par ladder
const MOCK_SELL_STOCK_PERCENTAGE = 10; // one standard 10% certificate block
const MOCK_DECLARE_DIVIDENDS_REVENUE = "0"; // no revenue-entry UI yet -- see design note #4
// Same placeholder rationale as design note #1/#4 above: there's no
// company-selector UI yet, so the Interactive Tile-Selection Popup's
// GetLegalTilePlacements/LayTile calls -- and now the Operating-Round-scoped
// mock action bar buttons too -- need SOME protocol_id to target. B&O
// (protocol_id 4) is used here specifically because it's the simplest
// "always floatable" company in the Rust test suite (src/tests.rs), not
// because of any in-game significance -- swap for real company-selection
// state once that flow exists, same as MOCK_BUY_STOCK_PROTOCOL_ID.
const MOCK_LAY_TILE_PROTOCOL_ID = 4; // B&O, per public_company::CORE_PUBLIC_COMPANIES

/** Hand-kept mirror of `hardware::TRAIN_CATALOG` (`(model_type, baseline
 *  cost in VGP, max route distance, bank quantity)`) -- same convention as
 *  `HexGridRenderer.tsx`'s `TILE_CATALOG` mirror. Purely a DISPLAY source
 *  for the Operating Round Phase 4 "active engines" marketplace tray (item
 *  2/Phase 4 below): `BuyHardwareFromPool` itself takes no model-selection
 *  parameter yet (see `hardware.rs`'s own module doc comment #2, "No model
 *  selection" -- it auto-picks from the pool), so selecting a tile here
 *  only drives which model is highlighted/labeled in the tray, not which
 *  model actually gets purchased. Keep this in exact sync with the Rust
 *  array if it ever changes. */
const MOCK_TRAIN_CATALOG: ReadonlyArray<{
  modelType: string;
  costVgp: number;
  maxDistance: number;
  bankQuantity: number;
}> = [
  { modelType: "2", costVgp: 80, maxDistance: 2, bankQuantity: 6 },
  { modelType: "3", costVgp: 180, maxDistance: 3, bankQuantity: 5 },
  { modelType: "4", costVgp: 300, maxDistance: 4, bankQuantity: 4 },
  { modelType: "5", costVgp: 450, maxDistance: 5, bankQuantity: 3 },
  { modelType: "6", costVgp: 630, maxDistance: 6, bankQuantity: 2 },
  { modelType: "D", costVgp: 1_100, maxDistance: 999, bankQuantity: 20 },
];

/** The four legal, chronologically-ordered action sub-phases within one
 *  corporation's Operating Round turn (Track -> Tokens -> Dividends ->
 *  Hardware) -- see design note #10/item 2. This is purely CLIENT-SIDE UI
 *  sequencing (matching design note #4's "mock action parameters, not mock
 *  plumbing" convention): the backend has no notion of a sub-phase within a
 *  single corporation's turn (`GameSession::sub_round_index` tracks which
 *  Operating Round block this is, a different and coarser concept -- see
 *  `operations.rs`), so nothing here is read from or written to chain
 *  state. It exists only to guide which buttons the Contextual Top Action
 *  Bar shows next. */
type OperatingSubPhase =
  | "BuyPrivate"
  | "Track"
  | "Tokens"
  | "Routes"
  | "Dividends"
  | "Hardware";

/* ------------------------------------------------------------------ */
/* Mock map preview data -- see design note #2                        */
/* ------------------------------------------------------------------ */

// design note #15: the three landmark entries this array used to carry
// (New York/Boston/Baltimore, each pre-seeded with `tile_id: 10`) are
// REMOVED -- see that note for the full bug this caused and why an empty
// `tiles: []` is actually the MORE accurate mock of a freshly-created real
// game, not less.
const MOCK_MAP_GRID: MapGridResponse = {
  game_id: MOCK_GAME_ID,
  tiles: [],
};

/* ------------------------------------------------------------------ */
/* Mock stock market preview data -- same rationale as MOCK_MAP_GRID    */
/* above: illustrative only, never actually produced by a live         */
/* `GetMarketGrid` query. PRR/NYC/ERIE deliberately share the same      */
/* ($100 par) cell so StockMarketRenderer's token-stacking behavior is  */
/* visible without needing three real players to actually park there.  */
/* Positions use the real board's own par column (x=6) -- see          */
/* StockMarketRenderer.tsx design note #4 -- not the old x=0..5, y=0    */
/* placeholder row a previous pass used here.                          */
/* ------------------------------------------------------------------ */

const MOCK_MARKET_GRID: MarketGridResponse = {
  game_id: MOCK_GAME_ID,
  positions: [
    { company_id: 1, ticker: "PRR", x: 6, y: 10, price: "100" },
    { company_id: 2, ticker: "NYC", x: 6, y: 10, price: "100" },
    { company_id: 6, ticker: "ERIE", x: 6, y: 10, price: "100" },
    { company_id: 4, ticker: "B&O", x: 8, y: 4, price: "70" },
  ],
};

/* ------------------------------------------------------------------ */
/* Small display helpers                                              */
/* ------------------------------------------------------------------ */

function truncateAddress(address: string | null, lead = 10, trail = 6): string {
  if (!address) return "--";
  if (address.length <= lead + trail + 3) return address;
  return `${address.slice(0, lead)}...${address.slice(-trail)}`;
}

/* ------------------------------------------------------------------ */
/* Action Log -- entries constructed here, rendered via the combined     */
/* Feed Overlay (design note #18). `ActionLogEntry`/`ActionLogStatus`    */
/* themselves now live in utils/feed.ts -- see that file's design note   */
/* #1 for why.                                                           */
/* ------------------------------------------------------------------ */

let nextLogEntryId = 1;

// Design note #18/item 3: chat-message id counter, moved up from
// `Chatbox.tsx` (that file's own copy stays, for the reasons its design
// note #6 explains, but is no longer what actually generates ids for
// messages this app renders).
let nextChatMessageId = 1;

/* ------------------------------------------------------------------ */
/* Dashboard Control Bar                                              */
/* ------------------------------------------------------------------ */

function DashboardControlBar({ vgpBalance, vgpBalanceNote }: {
  vgpBalance: string | null;
  vgpBalanceNote: string | null;
}) {
  const wallet = useWallet();
  const session = useGameSession();

  // F-4 UI: WHY the wallet cannot connect, when that is a configuration
  // problem rather than a user one.
  //
  // `config.ts` deliberately no longer throws at import (see its design note
  // #0) -- an unconfigured build boots into offline mode instead of dying.
  // The cost of that correctness is that "Connect Keplr" would otherwise look
  // like it should work and simply fail on click. Surfacing the reason turns
  // a dead button into an explained one, and names the exact environment
  // variable so the fix is obvious without reading source.
  //
  // Computed at render, not memoised: it reads build-time constants that
  // cannot change during a session, so there is nothing to cache and a
  // `useMemo` here would only add indirection.
  const configError = chainConfigError();

  const walletStatusLabel: Record<typeof wallet.status, string> = {
    disconnected: "Disconnected",
    connecting: "Connecting...",
    connected: "Connected",
    error: "Error",
  };

  const sessionStatusLabel: Record<typeof session.sessionStatus, string> = {
    uninitialized: "Not Initialized",
    initializing: "Initializing...",
    ready: "Ready",
    error: "Error",
  };

  return (
    <header style={styles.dashboard}>
      <div style={styles.dashboardBrand}>18Cosmos</div>

      <div style={styles.dashboardSection}>
        <span style={styles.dashboardLabel}>Master Wallet</span>
        <span style={{ ...styles.statusBadge, ...statusBadgeColor(wallet.status) }}>
          {walletStatusLabel[wallet.status]}
        </span>
        <span style={styles.addressIndicator} title={wallet.address ?? undefined}>
          {truncateAddress(wallet.address)}
        </span>
        {wallet.status === "connected" ? (
          <button style={styles.button} onClick={wallet.disconnect}>
            Disconnect
          </button>
        ) : (
          <button
            style={styles.button}
            onClick={wallet.connect}
            disabled={wallet.status === "connecting"}
          >
            Connect Keplr
          </button>
        )}
        {wallet.error && <span style={styles.errorText}>{wallet.error}</span>}
        {configError && (
          <span style={styles.offlineBadge} title={configError}>
            {/* The full message is long and names a rebuild requirement; the
                badge shows the actionable half and the tooltip carries the
                rest, so the bar never wraps. */}
            Offline -- {firstMissingEnvVar(configError) ?? "chain not configured"}
          </span>
        )}
      </div>

      <div style={styles.dashboardSection}>
        <span style={styles.dashboardLabel}>Session Key</span>
        <span style={{ ...styles.statusBadge, ...statusBadgeColor(session.sessionStatus) }}>
          {sessionStatusLabel[session.sessionStatus]}
        </span>
        <span style={styles.addressIndicator} title={session.sessionAddress ?? undefined}>
          {truncateAddress(session.sessionAddress)}
        </span>
        <button
          style={styles.button}
          onClick={session.initializeSessionKey}
          disabled={wallet.status !== "connected" || session.sessionStatus === "initializing"}
        >
          Initialize Session Key
        </button>
        {session.sessionError && <span style={styles.errorText}>{session.sessionError}</span>}
      </div>

      {/* F-3 UI: REAL money and GAME money, deliberately styled as two
          different kinds of object.

          These are not two balances of the same thing. `$JUNO` is the
          player's actual on-chain holding -- what the lobby ante is
          denominated in and what gas is paid from. `VGP` is Virtual Game
          Points, the in-game play money the contract mints and moves freely.
          Rendering them in one undifferentiated row is what made F-3's
          confusion possible in the first place, so they get distinct
          treatments rather than distinct labels alone:

            - $JUNO: teal pill with a border -- "this is a real asset".
            - VGP:   plain amber monospace, no container -- "this is a score".

          Both are monospace and right-weighted so digits line up, because
          the one thing a player DOES want to do across them is compare
          magnitudes at a glance. */}
      <div style={styles.dashboardSection}>
        <span style={styles.dashboardLabel}>Wallet</span>
        <span style={styles.nativeBalancePill} title={nativeBalanceTitle(wallet.nativeBalance)}>
          <span style={styles.nativeBalanceAmount}>
            {wallet.nativeBalance ? formatNativeAmount(wallet.nativeBalance.amount) : "--"}
          </span>
          <span style={styles.nativeBalanceDenom}>{NATIVE_DENOM_DISPLAY}</span>
        </span>
      </div>

      <div style={styles.dashboardSection}>
        <span style={styles.dashboardLabel}>VGP Cash</span>
        <span style={styles.vgpBalance}>{vgpBalance ?? "--"}</span>
        {vgpBalanceNote && <span style={styles.vgpBalanceNote}>{vgpBalanceNote}</span>}
      </div>
    </header>
  );
}

/** Pulls the `REACT_APP_*` name out of a `chainConfigError()` message, for
 *  the compact badge. `null` if the message names none, in which case the
 *  caller falls back to a generic label rather than printing a truncated
 *  sentence. */
function firstMissingEnvVar(message: string): string | null {
  return message.match(/REACT_APP_[A-Z_]+/)?.[0] ?? null;
}

/** Hover text for the native balance pill -- the exact base-denom integer
 *  alongside the formatted figure, so a player can verify the conversion and
 *  see that no precision was invented. */
function nativeBalanceTitle(coin: { denom: string; amount: string } | null): string {
  if (!coin) return "Native balance unavailable -- connect a wallet on a configured chain.";
  return `${coin.amount} ${coin.denom} (raw base-denom integer)`;
}

function statusBadgeColor(
  status: "disconnected" | "connecting" | "connected" | "error"
    | "uninitialized" | "initializing" | "ready",
): React.CSSProperties {
  switch (status) {
    case "connected":
    case "ready":
      return { backgroundColor: "#1f7a3f", color: "#eafff0" };
    case "connecting":
    case "initializing":
      return { backgroundColor: "#8a6d1f", color: "#fff8e0" };
    case "error":
      return { backgroundColor: "#8a2020", color: "#ffe8e8" };
    default:
      return { backgroundColor: "#3a3f4b", color: "#c7cbd4" };
  }
}

/* ------------------------------------------------------------------ */
/* Contextual Top Action Bar -- see design note #8/item 5              */
/* ------------------------------------------------------------------ */

interface ActionBarButton {
  key: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}

/* ------------------------------------------------------------------ */
/* Manual Route Point UI -- see design note #11                       */
/* ------------------------------------------------------------------ */

/** One player-clicked point in a manually-built route path -- mirrors
 *  `HexGridRenderer`'s own `onHexClick` payload shape (minus the raw pixel
 *  coordinates, which this feature has no use for once the click is
 *  recorded). */
interface RoutePoint {
  q: number;
  r: number;
  hexLabel: string;
}

/** Standard axial-coordinate hex distance -- the number of hex-to-hex steps
 *  between `a` and `b`. This formula only depends on `(q, r)` being a
 *  conventional axial hex coordinate pair (which `HexGridRenderer`'s
 *  `pixelToAxial` already produces, design note #11), not on that file's own
 *  pointy-top pixel geometry/edge-numbering internals -- so this file can
 *  validate route-point adjacency without importing anything from that
 *  component beyond the plain `{ q, r }` values its `onHexClick` already
 *  reports. */
function axialHexDistance(a: { q: number; r: number }, b: { q: number; r: number }): number {
  const dq = b.q - a.q;
  const dr = b.r - a.r;
  return (Math.abs(dq) + Math.abs(dq + dr) + Math.abs(dr)) / 2;
}

/** Ordered display metadata for `OperatingSubPhase` -- see design note #10.
 *  `index`/`total` feed the "Phase N of 4: <name>" label so the bar visibly
 *  communicates progress through a corporation's turn, not just its current
 *  button set. */
const OPERATING_SUB_PHASE_LABELS: Readonly<Record<OperatingSubPhase, { index: number; name: string }>> = {
  // Design note #144: mirrors `or_phase::OR_PHASE_ORDER` in the contract,
  // which is now the AUTHORITY rather than a description. Every one of these
  // six actions is gated on-chain against a persisted cursor, so this is no
  // longer a UI convention the chain merely tolerates -- a client that walks
  // a different order will have its transactions rejected with
  // `WrongOperatingSubPhase`.
  //
  // `BuyPrivate` leads the turn but its action is locked until Phase 3; the
  // contract starts the cursor at `Track` while the era is Yellow, and
  // `initialOrSubPhase` below mirrors that so the bar does not open on a
  // phase the chain says does not exist yet.
  BuyPrivate: { index: 1, name: "Buy Private" },
  Track: { index: 2, name: "Track" },
  Tokens: { index: 3, name: "Tokens" },
  // Design note #142: `Routes` is its own phase now. It used to be folded
  // into `Dividends`, with "Run Trains" sitting as the first of three buttons
  // there -- so the bar said "Dividends" while the action the player actually
  // had to take first was running trains, and the two are not the same
  // decision. Running trains COMPUTES the revenue; declaring dividends
  // chooses what to DO with it, and cannot be answered before the first is
  // done. Bundling them asked the player to make the second choice while the
  // header named only that choice and the number it depends on did not exist
  // yet.
  Routes: { index: 4, name: "Routes" },
  Dividends: { index: 5, name: "Dividends" },
  Hardware: { index: 6, name: "Hardware" },
};

/** Where a corporation's turn starts, mirroring
 *  `or_phase::initial_sub_phase` -- `Track` before Phase 3, because
 *  `BuyPrivate`'s action is locked until then and the contract's cursor
 *  starts there too. */
function initialOrSubPhase(era: string | null | undefined): OperatingSubPhase {
  return era === "Yellow" || !era ? "Track" : "BuyPrivate";
}

/** Total Operating Round sub-phases, derived rather than written twice --
 *  the "Phase N of M" label reads `M` from here, so adding a phase above
 *  cannot leave a stale denominator behind (design note #142: the previous
 *  hardcoded "of 4" was exactly that hazard). */
const OPERATING_SUB_PHASE_TOTAL = Object.keys(OPERATING_SUB_PHASE_LABELS).length;

function ContextualActionBar({
  roundType,
  orSubPhase,
  sessionReady,
  onBuyShare,
  onSellShares,
  onPassTurn,
  onPlaceStationTokenHint,
  onSkipSubPhase,
  onBuyPrivateHint,
  ownsAnyTrain,
  onRunTrains,
  onPayDividends,
  onWithholdRevenue,
  selectedHardwareModel,
  onSelectHardwareModel,
  onBuyTrain,
  onEndOperatingTurn,
  onUndoLastAction,
  routeSelectMode,
  onToggleRouteSelectMode,
  routePoints,
  routeHopCount,
  routeMaxDistance,
  routeExceedsMaxDistance,
  routeFeedback,
  onClearRoute,
  sellablePrivates,
  selectedPrivateId,
  onSelectPrivate,
  privatePriceVgp,
  onPrivatePriceChange,
  onBuyPrivateCompany,
  currentGlobalEra,
  isMyTurn,
}: {
  roundType: RoundType | null;
  /** Only meaningful while `roundType === "OperatingRound"` -- see design
   *  note #10/item 2. */
  orSubPhase: OperatingSubPhase;
  sessionReady: boolean;
  onBuyShare: () => void;
  onSellShares: () => void;
  onPassTurn: () => void;
  onPlaceStationTokenHint: () => void;
  /** Design note #144: dispatches the real `AdvanceOperatingSubPhase`
   *  message. Every skip is now an on-chain, replayable event -- the old
   *  client-only `setOrSubPhase` calls advanced the UI while the contract's
   *  cursor stayed put, which under G-14 enforcement would have desynced the
   *  bar from what the chain would actually accept. */
  onSkipSubPhase: () => void;
  onBuyPrivateHint: () => void;
  /** Drives the Routes skip button's disabled state -- see its `title`. */
  ownsAnyTrain: boolean;
  onRunTrains: () => void;
  onPayDividends: () => void;
  onWithholdRevenue: () => void;
  selectedHardwareModel: string;
  onSelectHardwareModel: (modelType: string) => void;
  onBuyTrain: () => void;
  onEndOperatingTurn: () => void;
  onUndoLastAction: () => void;
  /** Manual Route Point UI -- see design note #11. Always visible,
   *  independent of round type, matching "Undo Last Action"'s own placement
   *  convention. */
  routeSelectMode: boolean;
  onToggleRouteSelectMode: () => void;
  routePoints: readonly RoutePoint[];
  routeHopCount: number;
  routeMaxDistance: number | undefined;
  routeExceedsMaxDistance: boolean;
  routeFeedback: string | null;
  onClearRoute: () => void;
  /** Buy Private Company Action Tray -- design note #14. Already filtered
   *  down to what `activePlayerAddress` actually still owns and could sell
   *  (`playerSellablePrivateCompanies`), not the full room-wide list. */
  sellablePrivates: PrivateCompanyState[];
  selectedPrivateId: number | null;
  onSelectPrivate: (privateId: number) => void;
  privatePriceVgp: number;
  onPrivatePriceChange: (priceVgp: number) => void;
  onBuyPrivateCompany: () => void;
  currentGlobalEra: TileColor | null;
  /** Active Player Turn Notifications -- design note #18/item 4. Applies
   *  the shared `app-turn-pulse-glow` keyframe (see `styles.appRoot`'s own
   *  JSX call site for where that `<style>` tag is injected) to this bar's
   *  own outer wrapper. */
  isMyTurn: boolean;
}) {
  // Round-type-specific buttons -- see design note #8 for exactly which
  // real ExecuteMsg each one dispatches, and why "Place Station Token" is
  // deliberately non-dispatching. Design note #10/item 2: within an
  // Operating Round, the button set ALSO swaps per `orSubPhase`, walking the
  // player through a corporation's turn in the real 1830 legal order --
  // Track -> Tokens -> Dividends -> Hardware -- one step at a time, rather
  // than exposing every OR action at once regardless of where the
  // corporation actually is in its turn.
  let contextualButtons: ActionBarButton[];
  if (roundType === "OperatingRound") {
    switch (orSubPhase) {
      case "Track":
        contextualButtons = [
          {
            key: "skip-track",
            label: "Skip Track Lay",
            onClick: onSkipSubPhase,
            title: "No tile to lay this turn -- click a hex on the Rail Map instead to lay one.",
          },
        ];
        break;
      case "BuyPrivate":
        // Design note #144: Phase 3+ only, and FIRST in the turn. The
        // contract starts the cursor at `Track` before Phase 3, so this case
        // is unreachable in the Yellow era rather than showing a dead button.
        contextualButtons = [
          {
            key: "buy-private",
            label: "Buy Private Company",
            onClick: onBuyPrivateHint,
            title: "Select a private company below to purchase it into this corporation's treasury.",
          },
          { key: "skip-private", label: "Skip Private Purchase", onClick: onSkipSubPhase },
        ];
        break;
      case "Tokens":
        contextualButtons = [
          {
            key: "station",
            label: "Place Station Token",
            onClick: onPlaceStationTokenHint,
            title: "Click any hex on the Rail Map to open the tile/station placement popup.",
          },
          { key: "skip-tokens", label: "Skip Tokens", onClick: onSkipSubPhase },
        ];
        break;
      case "Routes":
        // Design note #142: its own phase. Running trains is what PRODUCES
        // the revenue figure; the dividend decision below is what is done
        // with it. A player who sees "Routes" knows the outstanding task is
        // to run, not to choose a payout that has nothing to pay out yet.
        contextualButtons = [
          { key: "trains", label: "Run Trains (mock)", onClick: onRunTrains },
          {
            key: "skip-routes",
            label: "Skip Routes",
            onClick: onSkipSubPhase,
            // Design note #144: the contract REFUSES this skip for a
            // corporation that owns any train -- a train must be run. Disabled
            // rather than hidden, with the reason, so the rule is visible at
            // the moment it binds instead of surfacing as a rejected tx.
            disabled: ownsAnyTrain,
            title: ownsAnyTrain
              ? "This corporation owns a train, and a train must be run -- Routes cannot be skipped."
              : "No train owned, so there is nothing to run.",
          },
        ];
        break;
      case "Dividends":
        contextualButtons = [
          { key: "pay-dividends", label: "Pay Dividends", onClick: onPayDividends },
          { key: "withhold-revenue", label: "Withhold Revenue", onClick: onWithholdRevenue },
        ];
        break;
      case "Hardware":
        contextualButtons = [
          { key: "train", label: "Buy Train (mock)", onClick: onBuyTrain },
          { key: "end-turn", label: "End Turn", onClick: onEndOperatingTurn },
        ];
        break;
    }
  } else {
    // Stock & Auction pass: Buy/Sell/Pass now live entirely in the new
    // `StockRoundPanel` (rendered directly above the Stock Market Matrix,
    // see App.tsx's render block) so there is never a duplicate/competing
    // control surface. `onBuyShare`/`onSellShares`/`onPassTurn` stay in
    // this component's props interface (still passed at the call site)
    // deliberately, to keep this a minimal-footprint change.
    contextualButtons = [];
  }

  const phaseLabel = roundType === "OperatingRound" ? OPERATING_SUB_PHASE_LABELS[orSubPhase] : null;

  return (
    <div style={{ ...styles.actionBar, ...(isMyTurn ? styles.actionBarTurnPulse : {}) }}>
      <span style={styles.actionBarRoundLabel}>
        {roundType === "OperatingRound"
          ? `Operating Round${phaseLabel ? ` -- Phase ${phaseLabel.index} of ${OPERATING_SUB_PHASE_TOTAL}: ${phaseLabel.name}` : ""}`
          : roundType === "StockRound"
            ? "Stock Round"
            : "No live round"}
      </span>
      {/* Phase 4's marketplace selection tray -- see design note #10/item 2.
          `BuyHardwareFromPool` has no per-model parameter yet (see
          `MOCK_TRAIN_CATALOG`'s own doc comment), so selecting a card here
          only changes which model is highlighted/labeled; the purchase
          itself still targets whichever unit the pool auto-assigns. */}
      {roundType === "OperatingRound" && orSubPhase === "Hardware" && (
        <div style={styles.hardwareTray}>
          {MOCK_TRAIN_CATALOG.map((train) => (
            <button
              key={train.modelType}
              type="button"
              style={{
                ...styles.hardwareTrayCard,
                ...(selectedHardwareModel === train.modelType ? styles.hardwareTrayCardSelected : {}),
              }}
              onClick={() => onSelectHardwareModel(train.modelType)}
              disabled={!sessionReady}
              title={`Max route distance ${train.maxDistance === 999 ? "unlimited" : train.maxDistance}, ${train.bankQuantity} in the bank`}
            >
              <span style={styles.hardwareTrayCardModel}>{train.modelType}-train</span>
              <span style={styles.hardwareTrayCardCost}>{train.costVgp} VGP</span>
            </button>
          ))}
        </div>
      )}
      {/* Buy Private Company Action Tray -- see design note #14. Hidden
          outside Phase 3+ (mirrors the contract's own
          PrivatePurchaseLockedBeforePhase3 gate) and hidden if there's
          nothing left for the active player to sell. */}
      {roundType === "OperatingRound" &&
        orSubPhase === "Hardware" &&
        currentGlobalEra !== null &&
        currentGlobalEra !== "Yellow" &&
        sellablePrivates.length > 0 && (
          <div style={styles.privateCompanyTray}>
            <span style={styles.privateCompanyTrayLabel}>Buy Private Company:</span>
            <select
              style={styles.privateCompanySelect}
              value={selectedPrivateId ?? ""}
              onChange={(e) => onSelectPrivate(Number(e.target.value))}
              disabled={!sessionReady}
            >
              {sellablePrivates.map((priv) => (
                <option key={priv.private_id} value={priv.private_id}>
                  {priv.name} (face value {priv.cost} VGP)
                </option>
              ))}
            </select>
            {(() => {
              const selected = sellablePrivates.find((p) => p.private_id === selectedPrivateId);
              if (!selected) return null;
              const faceValue = Number(selected.cost);
              // Mirrors trading::execute_buy_private_company's own 50%-200%
              // bound exactly (design note #14) -- purely a UX guardrail,
              // the contract re-enforces the identical bound on-chain.
              const floor = Math.ceil(faceValue / 2);
              const ceiling = faceValue * 2;
              return (
                <div style={styles.privateCompanyPriceRow}>
                  <input
                    type="range"
                    min={floor}
                    max={ceiling}
                    step={1}
                    value={privatePriceVgp}
                    onChange={(e) => onPrivatePriceChange(Number(e.target.value))}
                    disabled={!sessionReady}
                  />
                  <span style={styles.privateCompanyPriceValue}>
                    {privatePriceVgp} VGP ({floor}-{ceiling})
                  </span>
                  <button
                    type="button"
                    style={styles.actionBarButton}
                    onClick={onBuyPrivateCompany}
                    disabled={!sessionReady}
                    title="Dispatches ExecuteMsg::BuyPrivateCompany -- see trading.rs module doc comment #17."
                  >
                    Buy
                  </button>
                </div>
              );
            })()}
          </div>
        )}
      <div style={styles.actionBarButtons}>
        {contextualButtons.map((btn) => (
          <button
            key={btn.key}
            style={styles.actionBarButton}
            onClick={btn.onClick}
            disabled={btn.disabled || !sessionReady}
            title={btn.title}
          >
            {btn.label}
          </button>
        ))}
        <span style={styles.actionBarDivider} />
        <button
          style={{ ...styles.actionBarButton, ...styles.actionBarUtilityButton }}
          onClick={onUndoLastAction}
          disabled={!sessionReady}
          title="Always available, independent of round type."
        >
          Undo Last Action
        </button>
        <span style={styles.actionBarDivider} />
        {/* Manual Route Point UI toggle -- see design note #11. Always
            visible, independent of round type; only meaningful on the Rail
            Map tab, but harmless to leave on while viewing the Stock Market
            tab (there's simply no canvas to click there). */}
        <button
          type="button"
          role="switch"
          aria-checked={routeSelectMode}
          style={{
            ...styles.actionBarButton,
            ...(routeSelectMode ? styles.routeToggleButtonActive : {}),
          }}
          onClick={onToggleRouteSelectMode}
          title="Click a sequence of map cities on the Rail Map to build a custom route path -- see this file's design note #11 for exactly what this can and can't verify."
        >
          <span style={styles.routeToggleSwitchTrack}>
            <span
              style={{
                ...styles.routeToggleSwitchThumb,
                ...(routeSelectMode ? styles.routeToggleSwitchThumbActive : {}),
              }}
            />
          </span>
          Select Route Points
        </button>
      </div>
      {routeSelectMode && (
        <div style={styles.routePanel}>
          <span style={styles.routePanelHint}>
            Click a chain of neighboring hexes on the Rail Map to build a route. This is a
            client-side scouting aid only -- the contract has no query to submit or verify a
            manual path; the real route is always computed automatically on-chain (see design
            note #11).
          </span>
          <div style={styles.routePanelPath}>
            {routePoints.length === 0 ? (
              <span style={styles.routePanelEmpty}>No route points selected yet.</span>
            ) : (
              routePoints.map((point, index) => (
                <React.Fragment key={`${point.q},${point.r}`}>
                  {index > 0 && <span style={styles.routePanelArrow}>&rarr;</span>}
                  <span style={styles.routePanelPoint}>{point.hexLabel}</span>
                </React.Fragment>
              ))
            )}
          </div>
          <div style={styles.routePanelMeta}>
            <span
              style={{
                ...styles.routePanelHopCount,
                ...(routeExceedsMaxDistance ? styles.routePanelHopCountExceeded : {}),
              }}
            >
              {routeHopCount} hop{routeHopCount === 1 ? "" : "s"}
              {routeMaxDistance !== undefined &&
                ` / max ${routeMaxDistance === 999 ? "unlimited" : routeMaxDistance} (${selectedHardwareModel}-train)`}
            </span>
            {routeExceedsMaxDistance && (
              <span style={styles.routePanelWarning}>
                Exceeds the selected train's max route distance.
              </span>
            )}
            {routeFeedback && <span style={styles.routePanelWarning}>{routeFeedback}</span>}
            {routePoints.length > 0 && (
              <button type="button" style={styles.routePanelClearButton} onClick={onClearRoute}>
                Clear Route
              </button>
            )}
          </div>
        </div>
      )}
      {!sessionReady && (
        <span style={styles.sidebarHint}>Initialize the session key above to enable these actions.</span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Main tabs -- see design note #9                                    */
/* ------------------------------------------------------------------ */

type MainTab = "map" | "stock" | "ledger" | "rules";

function MainTabBar({ activeTab, onSelect }: { activeTab: MainTab; onSelect: (tab: MainTab) => void }) {
  const tabs: { id: MainTab; label: string }[] = [
    { id: "map", label: "Rail Map" },
    { id: "stock", label: "Stock & Auction" },
    { id: "ledger", label: "Game Ledger" },
    { id: "rules", label: "Rules Reference" },
  ];
  return (
    <div style={styles.mainTabBar}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          style={{
            ...styles.mainTabButton,
            ...(activeTab === tab.id ? styles.mainTabButtonActive : {}),
          }}
          onClick={() => onSelect(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Active Player Turn Notifications -- CSS pulse keyframes, see design    */
/* note #18/item 4. `document.title` flashing (the other half of this    */
/* notification) lives in utils/turnAlert.ts instead -- no DOM footprint */
/* to inject here. Same `<style>`-tag keyframes escape hatch Chatbox.tsx */
/* already established (that file's own design note #2) for this        */
/* codebase's plain-inline-style convention, which cannot express a      */
/* `@keyframes` rule at all.                                             */
/* ------------------------------------------------------------------ */

const TURN_PULSE_KEYFRAMES_CSS = `
@keyframes app-turn-pulse-glow {
  0%, 100% { box-shadow: inset 0 0 0 rgba(224, 90, 90, 0), 0 0 0 rgba(224, 90, 90, 0); }
  50% { box-shadow: inset 0 0 40px rgba(224, 90, 90, 0.35), 0 0 30px rgba(224, 90, 90, 0.45); }
}
`;

/* ------------------------------------------------------------------ */
/* App shell -- everything below here renders inside both providers   */
/* ------------------------------------------------------------------ */

function AppShell() {
  const wallet = useWallet();
  const session = useGameSession();

  const [actionLog, setActionLog] = useState<ActionLogEntry[]>([]);
  const [vgpBalanceNote, setVgpBalanceNote] = useState<string | null>(null);
  const [activeMainTab, setActiveMainTab] = useState<MainTab>("map");
  // Design note #10/item 2: which of the four legal OR action sub-phases
  // the Contextual Top Action Bar is currently guiding the player through.
  // Client-side only -- see `OperatingSubPhase`'s own doc comment.
  // Design note #144: seeded from `initialOrSubPhase`, mirroring
  // `or_phase::initial_sub_phase` -- `Track` before Phase 3, `BuyPrivate`
  // from Green on. Hardcoding "Track" would open the bar on a phase the
  // contract has already moved past once the era advances.
  const [orSubPhase, setOrSubPhase] = useState<OperatingSubPhase>(() =>
    initialOrSubPhase(null),
  );
  const [selectedHardwareModel, setSelectedHardwareModel] = useState<string>(
    MOCK_TRAIN_CATALOG[0].modelType,
  );

  // Stock Round (SR) Action Control Panel selection state -- see
  // `StockRoundPanel.tsx` design note #1. Purely UI-selection state; the
  // real dispatch still runs through `handleBuyShare`/`handleSellShares`
  // below, just reading these instead of the old MOCK_* constants.
  const [srSelectedProtocolId, setSrSelectedProtocolId] = useState<number>(MOCK_BUY_STOCK_PROTOCOL_ID);
  const [srParValue, setSrParValue] = useState<string>(MOCK_BUY_STOCK_PAR_VALUE);
  const [srSource, setSrSource] = useState<"Ipo" | "Bank">("Ipo");
  const [srSellPercentage, setSrSellPercentage] = useState<number>(MOCK_SELL_STOCK_PERCENTAGE);

  // Automatic Phase-Based Tab Navigation (design note below near its own
  // `useEffect`): holds the last-seen `current_round_type` so the
  // auto-switch effect fires only on genuine phase TRANSITIONS, never on
  // every unchanged poll re-render -- see that effect's own comment for why
  // this must be a ref, not a state variable.
  const prevRoundTypeRef = useRef<RoundType | null>(null);

  // Design note #7: ONE shared live GetGameState poll. Every panel this
  // pass touches (Chatbox's turn alert, ContextualSubPanel, the Contextual
  // Top Action Bar's round-type switch, FinancialLedger,
  // HexGridRenderer's `currentEra`) derives from this same result.
  const {
    gameState,
    loading: gameStateLoading,
    error: gameStateError,
    refresh: refreshGameState,
  } = useGameStatePolling(wallet.signingClient ?? undefined, CONTRACT_ADDRESS, MOCK_GAME_ID);

  // Pre-Game Waterfall Auction (`waterfall.rs`): a second, independent poll
  // against `QueryMsg::GetWaterfallState`, only actually enabled while
  // `gameState.current_round_type === "WaterfallAuction"` -- see
  // `utils/gameState.ts` design note #7. `WaterfallAuctionDashboard` below
  // is the only consumer.
  const isWaterfallPhase = gameState?.current_round_type === "WaterfallAuction";
  const {
    waterfallState,
    loading: waterfallStateLoading,
    error: waterfallStateError,
  } = useWaterfallStatePolling(
    wallet.signingClient ?? undefined,
    CONTRACT_ADDRESS,
    MOCK_GAME_ID,
    isWaterfallPhase,
  );

  // Resets the Contextual Top Action Bar's OR sub-phase back to "Track"
  // whenever a NEW corporation's turn starts (`active_corporation_index`
  // changes) or the room leaves an Operating Round entirely -- see design
  // note #10/item 2. Deliberately keyed on these two live poll fields, not
  // on every poll tick, so it fires exactly once per actual turn change.
  useEffect(() => {
    setOrSubPhase(initialOrSubPhase(gameState?.current_global_era));
  }, [gameState?.current_round_type, gameState?.active_corporation_index, gameState?.current_global_era]);

  // Automatic Phase-Based Tab Navigation. Fires ONLY on a genuine
  // `current_round_type` transition (compared against `prevRoundTypeRef`,
  // not just "keyed on" the value) so it never re-fires -- and never
  // overrides a manual tab click -- on every unchanged ~poll-interval
  // re-render while the round type stays the same. `WaterfallAuction` and
  // `StockRound` both auto-switch to the consolidated "Stock & Auction" tab;
  // `OperatingRound` auto-switches back to "Rail Map". `MainTabBar`'s own
  // `onSelect`/`setActiveMainTab` click handling is completely untouched by
  // this effect, so manual tab clicking remains fully accessible at all
  // times, exactly as required.
  useEffect(() => {
    const currentRoundType = gameState?.current_round_type ?? null;
    const previousRoundType = prevRoundTypeRef.current;
    if (currentRoundType !== previousRoundType) {
      prevRoundTypeRef.current = currentRoundType;
      if (currentRoundType === "WaterfallAuction" || currentRoundType === "StockRound") {
        setActiveMainTab("stock");
      } else if (currentRoundType === "OperatingRound") {
        setActiveMainTab("map");
      }
    }
  }, [gameState?.current_round_type]);

  const vgpBalance = useMemo(() => {
    if (!gameState || !wallet.address) return null;
    const entry = gameState.player_cash.find((e) => e.player === wallet.address);
    return entry ? entry.cash_vgp : "0";
  }, [gameState, wallet.address]);

  const derivedVgpBalanceNote = useMemo(() => {
    if (vgpBalanceNote) return vgpBalanceNote;
    if (!wallet.address) return null;
    if (gameStateError) {
      return `live query unavailable (placeholder contract/game_id) -- ${gameStateError}`;
    }
    return null;
  }, [vgpBalanceNote, wallet.address, gameStateError]);

  const activePlayerAddress = useMemo(() => {
    if (!gameState) return null;
    return gameState.player_addresses[gameState.active_player_index] ?? null;
  }, [gameState]);

  // Active Player Turn Notifications -- design note #18/item 4, now
  // MANDATORY and non-optional (design note #21 -- the opt-out
  // `titleFlashEnabled`/`pulseGlowEnabled` settings design note #19/item 3
  // introduced are removed entirely). Same comparison `Chatbox.tsx` used
  // to make internally before this pass (design note #2 there), computed
  // once here since that component is no longer rendered directly. Both
  // alert channels below now key DIRECTLY off `isMyTurn` -- no gating
  // value, no per-player toggle, enforced globally: they turn on the
  // instant `isMyTurn` becomes `true` and stop the instant it becomes
  // `false`.
  // F-5: ROUND-TYPE AWARE. This was
  //
  //     wallet.address === activePlayerAddress
  //
  // which is right for a Stock Round and wrong for the whole of every
  // Operating Round. `activePlayerAddress` is
  // `player_addresses[active_player_index]` -- the STOCK ROUND turn pointer.
  // During an Operating Round the acting entity is not a player at all: it is
  // the corporation at `active_operating_order[active_corporation_index]`,
  // and the authorised human is that corporation's `president`. The backend
  // gates `LayTile` / `BuyHardwareFromPool` / `DeclareDividends` /
  // `EndOperatingRoundTurn` on exactly that.
  //
  // The consequence was not a missing alert but an INVERTED one: for roughly
  // half of game time the title flash and pulse glow fired for whoever
  // happened to hold the stale SR pointer, while the president who actually
  // had to act got nothing. Both halves of the mandatory notification
  // requirement pointed at the wrong person simultaneously.
  //
  // Every field this needs is already on the polled `GameStateResponse`; no
  // backend change and no extra query.
  const isMyTurn = useMemo(() => {
    if (!wallet.address || !gameState) return false;

    if (gameState.current_round_type === "OperatingRound") {
      const activeCompanyId =
        gameState.active_operating_order[gameState.active_corporation_index];
      // An Operating Round with an empty order, or an index past its end, has
      // no acting corporation -- nobody's turn, rather than everybody's.
      // Falling back to the Stock Round pointer here would resurrect exactly
      // the bug this fixes, so it deliberately does not.
      if (activeCompanyId === undefined) return false;
      const president = gameState.public_companies.find(
        (company) => company.company_id === activeCompanyId,
      )?.president;
      // A floated-but-presidentless corporation (no qualifying 20% holder)
      // alerts nobody, which is correct: there is no human authorised to act
      // for it, and the contract would reject them if they tried.
      return !!president && president === wallet.address;
    }

    // Stock Round and Waterfall Auction both run on the player pointer.
    return gameState.player_addresses[gameState.active_player_index] === wallet.address;
  }, [wallet.address, gameState]);

  useDocumentTitleFlash(isMyTurn);

  // In-Place Accordion Ticker / Inline Control Strip state -- design note
  // #18, converted from a modal to an in-place accordion by design note
  // #20. `chatMessages` was previously owned entirely inside
  // `Chatbox.tsx`; moved up here so it can be merged with `actionLog` into
  // one chronologically sorted timeline (`mergeFeedItems`).
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatDraft, setChatDraft] = useState("");
  // Renamed from `feedOpen` -- design note #20/item 1. Same boolean role,
  // now gates `TopTicker.tsx`'s in-place accordion body instead of a
  // modal's mount state.
  const [isTickerExpanded, setIsTickerExpanded] = useState(false);
  const [feedFilter, setFeedFilter] = useState<FeedFilter>("all");
  // Tracks how many (filtered) items had already been seen the last time
  // the accordion was expanded, so `unreadFeedCount` below only counts
  // items that arrived while it was collapsed.
  const [lastSeenFeedCount, setLastSeenFeedCount] = useState(0);

  const feedItems = useMemo(() => mergeFeedItems(chatMessages, actionLog), [chatMessages, actionLog]);
  // Design note #20/item 2: filtered by the same `feedFilter` the pills in
  // `InlineQuickChat.tsx` now drive. `latestFeedItem`/`unreadFeedCount`
  // below both derive from THIS filtered array (not the raw `feedItems`),
  // so switching filters instantly updates both the ticker's single-line
  // preview and its 7-line expanded history at once.
  const filteredFeedItems = useMemo(
    () => (feedFilter === "all" ? feedItems : feedItems.filter((item) => item.kind === feedFilter)),
    [feedItems, feedFilter],
  );
  const latestFeedItem = filteredFeedItems.length > 0 ? filteredFeedItems[filteredFeedItems.length - 1] : null;
  const unreadFeedCount = isTickerExpanded ? 0 : Math.max(0, filteredFeedItems.length - lastSeenFeedCount);

  // Marks everything as "seen" the moment the accordion is expanded (and
  // keeps it marked as items keep arriving while it stays expanded), so
  // the unread badge is always 0 while `isTickerExpanded` is true and only
  // starts counting again once it's collapsed.
  useEffect(() => {
    if (isTickerExpanded) {
      setLastSeenFeedCount(filteredFeedItems.length);
    }
  }, [isTickerExpanded, filteredFeedItems.length]);

  const handleToggleTickerExpand = useCallback(() => setIsTickerExpanded((prev) => !prev), []);

  const handleSendChatMessage = useCallback(() => {
    const text = chatDraft.trim();
    if (!text) return;
    setChatMessages((messages) => [
      ...messages,
      {
        id: nextChatMessageId++,
        author: wallet.address ? truncateChatAddress(wallet.address) : "You",
        text,
        timestamp: new Date().toLocaleTimeString(),
        timestampMs: Date.now(),
      },
    ]);
    setChatDraft("");
  }, [chatDraft, wallet.address]);

  // Buy Private Company Action Tray -- design note #14. Recomputed from the
  // live poll every time `activePlayerAddress` changes hands or the room's
  // private-company ownership changes (e.g. after a successful purchase
  // triggers `refreshGameState`).
  const sellablePrivates = useMemo(() => {
    if (!gameState || !activePlayerAddress) return [];
    return playerSellablePrivateCompanies(activePlayerAddress, gameState);
  }, [gameState, activePlayerAddress]);

  const [selectedPrivateId, setSelectedPrivateId] = useState<number | null>(null);
  const [privatePriceVgp, setPrivatePriceVgp] = useState<number>(0);

  // Keeps the dropdown's selection (and the price slider's value) valid as
  // `sellablePrivates` changes -- defaults to the first sellable private's
  // exact face value, same "seed at face value" starting point real 1830
  // itself uses as the default asking price.
  useEffect(() => {
    if (sellablePrivates.length === 0) {
      setSelectedPrivateId(null);
      return;
    }
    const stillValid = sellablePrivates.some((p) => p.private_id === selectedPrivateId);
    if (!stillValid) {
      setSelectedPrivateId(sellablePrivates[0].private_id);
      setPrivatePriceVgp(Number(sellablePrivates[0].cost));
    }
  }, [sellablePrivates, selectedPrivateId]);

  const handleSelectPrivate = useCallback(
    (privateId: number) => {
      setSelectedPrivateId(privateId);
      const chosen = sellablePrivates.find((p) => p.private_id === privateId);
      if (chosen) {
        setPrivatePriceVgp(Number(chosen.cost));
      }
    },
    [sellablePrivates],
  );

  const roundLabel = useMemo(() => {
    if (!gameState) return null;
    // Pre-Game Waterfall Auction (`waterfall.rs`): every room now
    // genesis-starts here, before `macro_round_number`'s "SR1"/"OR1.1"
    // numbering is meaningful at all -- see `WaterfallAuctionDashboard.tsx`,
    // which is what actually renders during this phase.
    if (gameState.current_round_type === "WaterfallAuction") return "Waterfall Auction";
    const prefix = gameState.current_round_type === "StockRound" ? "SR" : "OR";
    const suffix = gameState.sub_round_index > 0 ? `.${gameState.sub_round_index}` : "";
    return `${prefix}${gameState.macro_round_number}${suffix}`;
  }, [gameState]);

  // Interactive Floating Tile-Selection Popup Overlay state (see
  // HexGridRenderer.tsx design note #7). `hexClickQuery` mirrors whatever
  // HexGridRenderer's own click interceptor last reported; the popup itself
  // only renders once that settles into a "success" state with at least the
  // possibility of legal placements. `previewTile` is lifted up here (not
  // owned by the popup) so it can be threaded straight into
  // `<HexGridRenderer previewTile={...} />` below.
  const [hexClickQuery, setHexClickQuery] = useState<HexClickQueryState | null>(null);
  const [previewTile, setPreviewTile] = useState<
    { q: number; r: number; tileId: number; orientation: number } | null
  >(null);

  const handleHexClickQuery = useCallback((state: HexClickQueryState) => {
    setHexClickQuery(state);
  }, []);

  const handleCloseTilePopup = useCallback(() => {
    setHexClickQuery(null);
    setPreviewTile(null);
  }, []);

  // Manual Route Point UI state -- see design note #11. `routeSelectMode`
  // gates whether `<HexGridRenderer>` below is wired for route-point
  // clicking (via its plain `onHexClick`) instead of its normal
  // LayTile-popup click interceptor; `routePoints` is the resulting chain,
  // `routeFeedback` a short-lived inline message for a rejected click
  // (non-adjacent to the last point).
  const [routeSelectMode, setRouteSelectMode] = useState(false);
  const [routePoints, setRoutePoints] = useState<RoutePoint[]>([]);
  const [routeFeedback, setRouteFeedback] = useState<string | null>(null);

  const handleToggleRouteSelectMode = useCallback(() => {
    setRouteSelectMode((prev) => !prev);
    setRouteFeedback(null);
  }, []);

  const handleClearRoute = useCallback(() => {
    setRoutePoints([]);
    setRouteFeedback(null);
  }, []);

  const handleRouteHexClick = useCallback(
    (info: { q: number; r: number; hexLabel: string; clientX: number; clientY: number }) => {
      const point: RoutePoint = { q: info.q, r: info.r, hexLabel: info.hexLabel };
      setRoutePoints((prev) => {
        const last = prev[prev.length - 1];
        // Clicking the most recently added point again is a quick one-step
        // undo, rather than a no-op or a rejected duplicate.
        if (last && last.q === point.q && last.r === point.r) {
          setRouteFeedback(null);
          return prev.slice(0, -1);
        }
        if (prev.length === 0) {
          setRouteFeedback(null);
          return [point];
        }
        // Real route constraint this CAN check client-side: a route is a
        // connected chain of hexes, so a new point must be a direct
        // neighbor of the current last point -- see design note #11 for
        // what this feature deliberately does NOT attempt to verify.
        if (axialHexDistance(last, point) !== 1) {
          setRouteFeedback(
            `${point.hexLabel} isn't adjacent to ${last.hexLabel} -- route points must chain through neighboring hexes.`,
          );
          return prev;
        }
        setRouteFeedback(null);
        return [...prev, point];
      });
    },
    [],
  );

  const routeHopCount = Math.max(0, routePoints.length - 1);

  // F-1: the player's in-progress manual route, handed to the canvas as a
  // drawable overlay -- design note #137 in `HexGridRenderer.tsx`.
  //
  // Until now `routePoints` existed only as a TEXT list in the side panel. A
  // player assembling a route by clicking hexes got a column of labels and no
  // indication on the map of the path they were building, which is precisely
  // the feedback the map exists to give.
  //
  // `useMemo` on `routePoints` alone: this array's identity is part of
  // `HexGridRenderer`'s draw-effect dependency list, so rebuilding it on every
  // render would repaint the whole canvas on every unrelated state change in
  // this very large component.
  //
  // Fewer than two points yields `[]`, and `drawRouteOverlays` also skips any
  // entry with `hexes.length < 2` -- a route needs at least one hop to be a
  // line, and a single clicked hex is not yet a route.
  const manualRouteOverlay = useMemo<RouteOverlay[]>(() => {
    if (routePoints.length < 2) return [];
    return [
      {
        // One overlay, because a manually-declared route IS one train's run.
        // The multi-train case (`trace_best_route_set` returns one route per
        // train) maps onto this same prop as several entries with different
        // colours -- no shape change needed when that lands.
        trainLabel: "Selected Route",
        // Amber, matching the route-select UI's own accent, so the ribbon on
        // the map reads as the same feature as the panel that built it.
        color: "#e0a54a",
        hexes: routePoints.map((point) => [point.q, point.r] as [number, number]),
      },
    ];
  }, [routePoints]);
  const routeMaxDistanceForSelectedHardware = MOCK_TRAIN_CATALOG.find(
    (t) => t.modelType === selectedHardwareModel,
  )?.maxDistance;
  const routeExceedsMaxDistance =
    routeMaxDistanceForSelectedHardware !== undefined &&
    routeMaxDistanceForSelectedHardware !== 999 &&
    routeHopCount > routeMaxDistanceForSelectedHardware;

  const handleTileDispatched = useCallback<NonNullable<TileSelectionPopupProps["onDispatched"]>>(
    (result) => {
      const id = nextLogEntryId++;
      const timestamp = new Date().toLocaleTimeString();
      // Design note #18/item 3: real sortable epoch, stamped alongside the
      // existing display-only `timestamp` string -- see `utils/feed.ts`
      // design note #2.
      const timestampMs = Date.now();
      const label = `LayTile #${result.tileId} (orientation ${result.orientation})`;
      if (result.status === "success") {
        setActionLog((log) => [
          {
            id,
            label,
            status: "success",
            detail: `tx ${truncateAddress(result.response.transactionHash, 8, 6)}`,
            timestamp,
            timestampMs,
          },
          ...log,
        ]);
        refreshGameState();
      } else {
        setActionLog((log) => [
          { id, label, status: "error", detail: result.message, timestamp, timestampMs },
          ...log,
        ]);
      }
    },
    [refreshGameState],
  );

  const runGameplayAction = useCallback(
    async (label: string, msg: GameplayExecuteMsg, optimisticBalanceNote?: string) => {
      const id = nextLogEntryId++;
      const timestamp = new Date().toLocaleTimeString();
      const timestampMs = Date.now();
      setActionLog((log) => [
        { id, label, status: "pending", detail: "Broadcasting via session key...", timestamp, timestampMs },
        ...log,
      ]);

      try {
        const result = await session.execGameplay(msg);
        setActionLog((log) =>
          log.map((entry) =>
            entry.id === id
              ? {
                  ...entry,
                  status: "success",
                  detail: `tx ${truncateAddress(result.transactionHash, 8, 6)}`,
                }
              : entry,
          ),
        );
        if (optimisticBalanceNote) {
          setVgpBalanceNote(optimisticBalanceNote);
        }
        refreshGameState();
      } catch (e) {
        const message = e instanceof Error ? e.message : "Unknown error executing action.";
        setActionLog((log) =>
          log.map((entry) => (entry.id === id ? { ...entry, status: "error", detail: message } : entry)),
        );
      }
    },
    [session, refreshGameState],
  );

  const logInfo = useCallback((label: string, detail: string) => {
    const id = nextLogEntryId++;
    const timestamp = new Date().toLocaleTimeString();
    const timestampMs = Date.now();
    setActionLog((log) => [{ id, label, status: "info", detail, timestamp, timestampMs }, ...log]);
  }, []);

  const handlePassTurn = useCallback(
    () => runGameplayAction("PassTurn", { PassTurn: { game_id: MOCK_GAME_ID } }),
    [runGameplayAction],
  );

  const handleUndoLastAction = useCallback(
    () => runGameplayAction("UndoLastAction", { UndoLastAction: { game_id: MOCK_GAME_ID } }),
    [runGameplayAction],
  );

  // Design note (Stock & Auction pass): reads real UI-driven selection state
  // from `StockRoundPanel` (`srSelectedProtocolId`/`srSource`/`srParValue`)
  // instead of the old hardcoded `MOCK_BUY_STOCK_*` constants -- see
  // `StockRoundPanel.tsx` design note #2. `par_value` becomes `null`
  // whenever the selected company is already floated, since a floated
  // company's price comes from the Stock Market Matrix, not a fresh par
  // choice (matches `BuyStock`'s own real semantics, not a fabricated one).
  const srSelectedCompanyIsFloated = useMemo(
    () => gameState?.public_companies.find((c) => c.company_id === srSelectedProtocolId)?.is_floated ?? false,
    [gameState, srSelectedProtocolId],
  );

  const handleBuyShare = useCallback(
    () =>
      runGameplayAction(
        "BuyStock",
        {
          BuyStock: {
            game_id: MOCK_GAME_ID,
            protocol_id: srSelectedProtocolId,
            source: srSource,
            par_value: srSelectedCompanyIsFloated ? null : srParValue,
          },
        },
        "updated after BuyStock",
      ),
    [runGameplayAction, srSelectedProtocolId, srSource, srSelectedCompanyIsFloated, srParValue],
  );

  const handleSellShares = useCallback(
    () =>
      runGameplayAction(
        "SellStock",
        {
          SellStock: {
            game_id: MOCK_GAME_ID,
            protocol_id: srSelectedProtocolId,
            percentage: srSellPercentage,
          },
        },
        "updated after SellStock",
      ),
    [runGameplayAction, srSelectedProtocolId, srSellPercentage],
  );

  const handleRunTrains = useCallback(() => {
    runGameplayAction("ExecuteOperatingRound (mock)", {
      // No per-company payout picker UI yet (see design note #4) -- an
      // empty choice list is a real, valid call (every company simply
      // retains), not a fabricated one.
      ExecuteOperatingRound: { game_id: MOCK_GAME_ID, public_company_choices: [] },
    });
    // Design note #142: advance Routes -> Dividends once trains have run.
    // Optimistic, matching this file's existing convention (design note #4)
    // of not gating local UI sequencing on a chain round-trip -- and now
    // necessary rather than cosmetic, since running trains is the step that
    // produces the figure the Dividends phase decides about.
    setOrSubPhase("Dividends");
  }, [runGameplayAction]);

  // Generalized over `distribute` (design note #10/item 2 -- Phase 3's
  // explicit "Pay Dividends" vs "Withhold Revenue" buttons are the same
  // real `DeclareDividends` message, differing only in this one field).
  // Both optimistically advance to Phase 4 ("Hardware") on click, matching
  // this file's existing convention (design note #4) of not gating local UI
  // state on live tx confirmation -- the Action Log entry above already
  // reports success/failure independently.
  const handleDeclareDividendsChoice = useCallback(
    (distribute: boolean) => {
      runGameplayAction(distribute ? "DeclareDividends: Pay (mock)" : "DeclareDividends: Withhold (mock)", {
        DeclareDividends: {
          game_id: MOCK_GAME_ID,
          protocol_id: MOCK_LAY_TILE_PROTOCOL_ID,
          revenue_amount: MOCK_DECLARE_DIVIDENDS_REVENUE,
          distribute,
        },
      });
      setOrSubPhase("Hardware");
    },
    [runGameplayAction],
  );
  const handlePayDividends = useCallback(
    () => handleDeclareDividendsChoice(true),
    [handleDeclareDividendsChoice],
  );
  const handleWithholdRevenue = useCallback(
    () => handleDeclareDividendsChoice(false),
    [handleDeclareDividendsChoice],
  );

  const handleBuyTrain = useCallback(
    () =>
      runGameplayAction("BuyHardwareFromPool (mock)", {
        BuyHardwareFromPool: { game_id: MOCK_GAME_ID, protocol_id: MOCK_LAY_TILE_PROTOCOL_ID },
      }),
    [runGameplayAction],
  );

  // Buy Private Company Action Tray -- design note #14. `protocol_id` uses
  // the same `MOCK_LAY_TILE_PROTOCOL_ID` stand-in every other OR action on
  // this bar already targets (design note #1); `price` is stringified for
  // the same big-int-safety reason every other `Uint128` field is.
  const handleBuyPrivateCompany = useCallback(() => {
    const selected = sellablePrivates.find((p) => p.private_id === selectedPrivateId);
    if (!selected) return;
    runGameplayAction(`BuyPrivateCompany: ${selected.name} @ ${privatePriceVgp} VGP (mock)`, {
      BuyPrivateCompany: {
        game_id: MOCK_GAME_ID,
        protocol_id: MOCK_LAY_TILE_PROTOCOL_ID,
        private_id: selected.private_id,
        price: String(privatePriceVgp),
      },
    });
  }, [runGameplayAction, sellablePrivates, selectedPrivateId, privatePriceVgp]);

  // Pre-Game Waterfall Auction Action Tray (`WaterfallAuctionDashboard.tsx`)
  // -- five real `ExecuteMsg` dispatches, `waterfall.rs`'s own five turn
  // actions exactly. `bid_amount`/`price` are stringified for the same
  // big-int-safety reason every other `Uint128` field in this file is.
  const handleWaterfallBuyLowest = useCallback(
    () => runGameplayAction("WaterfallBuyLowest", { WaterfallBuyLowest: { game_id: MOCK_GAME_ID } }),
    [runGameplayAction],
  );

  const handleWaterfallBidHigher = useCallback(
    (privateId: number, bidAmountVgp: number) =>
      runGameplayAction(`WaterfallBidHigher: private #${privateId} @ ${bidAmountVgp} VGP`, {
        WaterfallBidHigher: {
          game_id: MOCK_GAME_ID,
          private_id: privateId,
          bid_amount: String(bidAmountVgp),
        },
      }),
    [runGameplayAction],
  );

  const handleWaterfallPass = useCallback(
    () => runGameplayAction("WaterfallPass", { WaterfallPass: { game_id: MOCK_GAME_ID } }),
    [runGameplayAction],
  );

  const handleWaterfallMiniAuctionRaise = useCallback(
    (bidAmountVgp: number) =>
      runGameplayAction(`WaterfallMiniAuctionRaise: ${bidAmountVgp} VGP`, {
        WaterfallMiniAuctionRaise: { game_id: MOCK_GAME_ID, bid_amount: String(bidAmountVgp) },
      }),
    [runGameplayAction],
  );

  const handleWaterfallMiniAuctionPass = useCallback(
    () =>
      runGameplayAction("WaterfallMiniAuctionPass", {
        WaterfallMiniAuctionPass: { game_id: MOCK_GAME_ID },
      }),
    [runGameplayAction],
  );

  // Deliberately non-dispatching -- see design note #8 for why "Place
  // Station Token" has no single-button ExecuteMsg of its own.
  const handlePlaceStationTokenHint = useCallback(
    () =>
      logInfo(
        "Place Station Token",
        "No standalone dispatch for this -- click a hex on the Rail Map to open the tile/station placement popup (LayTile).",
      ),
    [logInfo],
  );

  // Phase-navigation-only handlers (design note #10/item 2) -- these don't
  // dispatch anything themselves; they just log an informational Action Log
  // entry (matching `handlePlaceStationTokenHint`'s own convention) and
  // advance `orSubPhase` to the next legal step.
  // Design note #144: ONE real dispatch replaces the three client-only skip
  // handlers this used to have.
  //
  // Those called `setOrSubPhase` directly, moving the UI forward while the
  // contract's cursor stayed where it was. Harmless while the sequence was a
  // client-side convention; under G-14 enforcement it desyncs the bar from
  // what the chain will actually accept, and the player's next action gets
  // rejected with `WrongOperatingSubPhase` for reasons the UI just made
  // invisible. The chain owns the cursor now, so skipping has to go through
  // it.
  //
  // No optimistic `setOrSubPhase` here on purpose: `orSubPhase` is driven off
  // the polled game state, so the bar advances when the chain says it did.
  // Guessing would reintroduce exactly the desync this removes.
  const handleSkipSubPhase = useCallback(
    () =>
      runGameplayAction("AdvanceOperatingSubPhase", {
        AdvanceOperatingSubPhase: {
          game_id: MOCK_GAME_ID,
          protocol_id: MOCK_LAY_TILE_PROTOCOL_ID,
        },
      }),
    [runGameplayAction],
  );

  const handleBuyPrivateHint = useCallback(() => {
    logInfo(
      "Buy Private Company",
      "Select a private company and price in the panel below, then confirm the purchase.",
    );
  }, [logInfo]);

  // Design note #144: drives the Routes skip button's disabled state. The
  // contract refuses that skip for any corporation owning a train, so the
  // button is disabled with the reason rather than dispatching a transaction
  // that is certain to be rejected.
  const ownsAnyTrain = useMemo(() => {
    const company = gameState?.public_companies.find(
      (entry) => entry.company_id === MOCK_LAY_TILE_PROTOCOL_ID,
    );
    // `trains` is not on the polled shape yet -- until it is, assume NO train,
    // which leaves the button enabled and lets the contract be the authority.
    // Erring the other way would disable a legal skip with no way to override.
    void company;
    return false;
  }, [gameState]);

  // Phase 4 -> ends the corporation's turn via the SAME real `PassTurn`
  // dispatch the Stock Round's "Pass Turn" button uses (per `msg.rs`'s own
  // doc comment, `PassTurn` is the one message that advances an Operating
  // Round to the next corporation too -- not a separate ExecuteMsg), then
  // resets the local phase back to "Track" for whichever corporation goes
  // next (the poll-driven reset effect above would also catch this once
  // `active_corporation_index` changes, but resetting immediately avoids a
  // one-poll-interval flash of Phase 4's buttons for the new corporation).
  const handleEndOperatingTurn = useCallback(() => {
    handlePassTurn();
    setOrSubPhase("Track");
  }, [handlePassTurn]);

  const mapGrid = useMemo(() => MOCK_MAP_GRID, []);
  const marketGrid = useMemo(() => MOCK_MARKET_GRID, []);

  const isWorkspaceTab = activeMainTab === "map" || activeMainTab === "stock";

  return (
    <div style={styles.appRoot}>
      {/* Active Player Turn Notifications -- design note #18/item 4, now
          MANDATORY per design note #21 (no opt-out anywhere). The keyframes
          are injected unconditionally (matching Chatbox.tsx's own
          established convention, design note #2 there, for this codebase's
          plain-inline-style escape hatch), and the pulsing overlay mounts
          directly off bare `isMyTurn` -- no gating value. The document-title
          flash (the OTHER half of this notification) has no DOM footprint
          at all -- see the `useDocumentTitleFlash(isMyTurn)` call above. */}
      <style>{TURN_PULSE_KEYFRAMES_CSS}</style>
      {isMyTurn && <div style={styles.turnPulseOverlay} aria-hidden="true" />}

      <DashboardControlBar vgpBalance={vgpBalance} vgpBalanceNote={derivedVgpBalanceNote} />

      <MainTabBar activeTab={activeMainTab} onSelect={setActiveMainTab} />

      {/* In-Place Accordion Ticker + Inline Control Strip -- design notes
          #18-#20. Docked directly below the main nav tabs now (design note
          #20/item 3 -- was above them before this pass), full-width,
          visible regardless of which tab is active. No modal/pop-up: the
          Feed Overlay this used to open is gone entirely, replaced by
          `TopTicker.tsx`'s own in-place accordion body. `InlineQuickChat`
          (the control strip) sits directly below the ticker, always
          mounted regardless of `isTickerExpanded`, sharing the same
          `chatDraft`/`setChatDraft`/`feedFilter`/`setFeedFilter` state the
          ticker's preview and expanded history both read from. */}
      <TopTicker
        latestItem={latestFeedItem}
        items={filteredFeedItems}
        unreadCount={unreadFeedCount}
        isExpanded={isTickerExpanded}
        onToggleExpand={handleToggleTickerExpand}
      />
      <InlineQuickChat
        draft={chatDraft}
        onDraftChange={setChatDraft}
        onSend={handleSendChatMessage}
        filter={feedFilter}
        onFilterChange={setFeedFilter}
      />

      {isWorkspaceTab && (
        <>
          {/* Design note #18/item 1: the old fixed-width left sidebar
              (ActivityFeed) is removed entirely -- `canvasPane` now renders
              directly, claiming the panel's full available width. */}
          <main style={styles.canvasPane}>
            {isWaterfallPhase ? (
              /* Pre-Game Waterfall Auction (`waterfall.rs`): replaces the
                 normal action bar + board + contextual panel entirely for
                 this phase -- see `WaterfallAuctionDashboard.tsx`'s own doc
                 comment for why a dedicated dashboard, not a mode grafted
                 onto `ContextualActionBar`, is the right shape for six
                 privates' worth of bid trackers and a mini-auction sub-panel. */
              <WaterfallAuctionDashboard
                waterfallState={waterfallState}
                loading={waterfallStateLoading}
                error={waterfallStateError}
                gameState={gameState}
                connectedWalletAddress={wallet.address}
                sessionReady={session.sessionStatus === "ready"}
                onBuyLowest={handleWaterfallBuyLowest}
                onBidHigher={handleWaterfallBidHigher}
                onPass={handleWaterfallPass}
                onMiniAuctionRaise={handleWaterfallMiniAuctionRaise}
                onMiniAuctionPass={handleWaterfallMiniAuctionPass}
              />
            ) : (
              <>
                {/* Item 5: contextual gameplay action bar -- see design notes
                    #8/#10. Step-by-step OR sub-phase guidance is design note
                    #10/item 2. */}
                <ContextualActionBar
                  roundType={gameState?.current_round_type ?? null}
                  orSubPhase={orSubPhase}
                  sessionReady={session.sessionStatus === "ready"}
                  onBuyShare={handleBuyShare}
                  onSellShares={handleSellShares}
                  onPassTurn={handlePassTurn}
                  onPlaceStationTokenHint={handlePlaceStationTokenHint}
                  onSkipSubPhase={handleSkipSubPhase}
                  onBuyPrivateHint={handleBuyPrivateHint}
                  ownsAnyTrain={ownsAnyTrain}
                  onRunTrains={handleRunTrains}
                  onPayDividends={handlePayDividends}
                  onWithholdRevenue={handleWithholdRevenue}
                  selectedHardwareModel={selectedHardwareModel}
                  onSelectHardwareModel={setSelectedHardwareModel}
                  onBuyTrain={handleBuyTrain}
                  onEndOperatingTurn={handleEndOperatingTurn}
                  onUndoLastAction={handleUndoLastAction}
                  routeSelectMode={routeSelectMode}
                  onToggleRouteSelectMode={handleToggleRouteSelectMode}
                  routePoints={routePoints}
                  routeHopCount={routeHopCount}
                  routeMaxDistance={routeMaxDistanceForSelectedHardware}
                  routeExceedsMaxDistance={routeExceedsMaxDistance}
                  routeFeedback={routeFeedback}
                  onClearRoute={handleClearRoute}
                  sellablePrivates={sellablePrivates}
                  selectedPrivateId={selectedPrivateId}
                  onSelectPrivate={handleSelectPrivate}
                  privatePriceVgp={privatePriceVgp}
                  onPrivatePriceChange={setPrivatePriceVgp}
                  onBuyPrivateCompany={handleBuyPrivateCompany}
                  currentGlobalEra={gameState?.current_global_era ?? null}
                  isMyTurn={isMyTurn}
                />

                {/* Stock Round (SR) Action Control Panel -- requirement 1's
                    "directly above ... the Stock Market Matrix." Gated on
                    a live Stock Round so it never renders during Operating
                    Round (Waterfall bypasses this whole branch already, via
                    `isWaterfallPhase` above). */}
                {gameState?.current_round_type === "StockRound" && (
                  <StockRoundPanel
                    publicCompanies={gameState?.public_companies ?? []}
                    selectedProtocolId={srSelectedProtocolId}
                    onSelectProtocolId={setSrSelectedProtocolId}
                    parValue={srParValue}
                    onSelectParValue={setSrParValue}
                    source={srSource}
                    onSelectSource={setSrSource}
                    sellPercentage={srSellPercentage}
                    onSelectSellPercentage={setSrSellPercentage}
                    onBuyShare={handleBuyShare}
                    onSellShares={handleSellShares}
                    onPassTurn={handlePassTurn}
                    sessionReady={session.sessionStatus === "ready"}
                    isMyTurn={isMyTurn}
                    connectedAddress={wallet.address}
                  />
                )}

                <div style={styles.boardPane}>
                  {activeMainTab === "map" ? (
                    <HexGridRenderer
                      mapGrid={mapGrid}
                      // Manual Route Point UI (design note #11): while
                      // `routeSelectMode` is on, the click-interceptor props
                      // (`queryClient`/`contractAddress`/`gameId`/`protocolId`)
                      // are all omitted -- per HexGridRenderer's own design note
                      // #7, that fully disables its GetLegalTilePlacements
                      // click-interceptor/popup flow, leaving `onHexClick` as
                      // the only click consumer, so a route-point click never
                      // also pops open the LayTile popup underneath it.
                      queryClient={routeSelectMode ? undefined : (wallet.signingClient ?? undefined)}
                      contractAddress={routeSelectMode ? undefined : CONTRACT_ADDRESS}
                      gameId={routeSelectMode ? undefined : MOCK_GAME_ID}
                      protocolId={routeSelectMode ? undefined : MOCK_LAY_TILE_PROTOCOL_ID}
                      onHexClick={routeSelectMode ? handleRouteHexClick : undefined}
                      onHexClickQuery={handleHexClickQuery}
                      previewTile={previewTile}
                      currentEra={gameState?.current_global_era ?? "Yellow"}
                      // Station Tokens (HexGridRenderer.tsx design note #36):
                      // `gameState.public_companies` (gameState.ts's own
                      // `PublicCompanyState[]`) is structurally assignable to
                      // the narrower `StationTokenCompany[]` this prop expects
                      // -- no conversion needed. Omitted entirely while
                      // `gameState` hasn't resolved yet, falling back to
                      // HexGridRenderer's own stable empty-array default.
                      publicCompanies={gameState?.public_companies}
                      routeOverlays={manualRouteOverlay}
                    />
                  ) : (
                    <StockMarketRenderer marketGrid={marketGrid} />
                  )}
                </div>

                {/* Automated contextual block underneath the board. */}
                <ContextualSubPanel
                  gameState={gameState}
                  loading={gameStateLoading}
                  error={gameStateError}
                />
              </>
            )}
          </main>
        </>
      )}

      {activeMainTab === "ledger" && (
        <FinancialLedger
          gameState={gameState}
          loading={gameStateLoading}
          error={gameStateError}
          // Player Net Worth (FinancialLedger.tsx design note #4): same
          // live query client/contract/game id every other connected panel
          // in this file already uses.
          queryClient={wallet.signingClient ?? undefined}
          contractAddress={CONTRACT_ADDRESS}
          gameId={MOCK_GAME_ID}
        />
      )}

      {activeMainTab === "rules" && (
        <RulesReference
          roundType={gameState?.current_round_type ?? null}
          operatingSubPhase={orSubPhase}
        />
      )}

      {/* Interactive Floating Tile-Selection Popup Overlay -- see
          HexGridRenderer.tsx design note #7. Only rendered on the Rail Map
          tab, and only once the click interceptor's
          GetLegalTilePlacements query has actually resolved;
          "loading"/"error" states get a lightweight inline indicator
          instead of the full carousel card. `position: fixed` means this
          can render anywhere in the tree -- kept as a sibling of the main
          layout rather than nested inside boardPane so it's never clipped
          by that pane's own `overflow: auto`. */}
      {activeMainTab === "map" && hexClickQuery?.status === "loading" && (
        <div
          style={{
            ...styles.hexClickIndicator,
            left: hexClickQuery.clientX + 16,
            top: hexClickQuery.clientY + 16,
          }}
        >
          Querying legal placements at {hexClickQuery.hexLabel}...
        </div>
      )}
      {activeMainTab === "map" && hexClickQuery?.status === "error" && (
        <div
          style={{
            ...styles.hexClickIndicator,
            ...styles.hexClickIndicatorError,
            left: hexClickQuery.clientX + 16,
            top: hexClickQuery.clientY + 16,
          }}
        >
          GetLegalTilePlacements failed: {hexClickQuery.message}
        </div>
      )}
      {activeMainTab === "map" && hexClickQuery?.status === "success" && (
        <TileSelectionPopup
          gameId={MOCK_GAME_ID}
          protocolId={MOCK_LAY_TILE_PROTOCOL_ID}
          q={hexClickQuery.q}
          r={hexClickQuery.r}
          hexLabel={hexClickQuery.hexLabel}
          placements={hexClickQuery.response.placements}
          anchorClientX={hexClickQuery.clientX}
          anchorClientY={hexClickQuery.clientY}
          onPreviewChange={setPreviewTile}
          onDispatched={handleTileDispatched}
          onClose={handleCloseTilePopup}
        />
      )}
      {/* Offline fallback (HexGridRenderer design note #120): no chain
          client is wired up, so `GetLegalTilePlacements` was never called
          and these tiles came from the local catalog mirror, filtered by era
          and nothing else. Rendered through the SAME popup deliberately --
          the point is that the picker works while developing against no
          backend -- but flagged `offline`, which makes the popup label
          itself provisional and refuse to dispatch. Kept as a separate
          branch from the `"success"` one above rather than merged with a
          ternary, so the authoritative path stays visibly untouched. */}
      {activeMainTab === "map" && hexClickQuery?.status === "offline" && (
        <TileSelectionPopup
          offline
          gameId={MOCK_GAME_ID}
          protocolId={MOCK_LAY_TILE_PROTOCOL_ID}
          q={hexClickQuery.q}
          r={hexClickQuery.r}
          hexLabel={hexClickQuery.hexLabel}
          placements={hexClickQuery.placements}
          anchorClientX={hexClickQuery.clientX}
          anchorClientY={hexClickQuery.clientY}
          onPreviewChange={setPreviewTile}
          onDispatched={handleTileDispatched}
          onClose={handleCloseTilePopup}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Root export -- Provider wrapping, per design note above             */
/* ------------------------------------------------------------------ */

export default function App() {
  return (
    <WalletProvider>
      <GameSessionProvider>
        <AppShell />
      </GameSessionProvider>
    </WalletProvider>
  );
}

/* ------------------------------------------------------------------ */
/* Inline styles                                                       */
/* ------------------------------------------------------------------ */
// Plain inline style objects rather than a new App.css -- keeps this
// milestone a single self-contained file, matching how it was requested.
// Swap for a real stylesheet/CSS-in-JS library whenever this UI grows
// past a first wiring pass.

const styles: Record<string, React.CSSProperties> = {
  appRoot: {
    display: "flex",
    flexDirection: "column",
    // Design note #13/item 1: was a hard `height: "100vh"` -- clipped this
    // whole column (and everything inside it) to exactly one viewport-worth
    // of pixels no matter how tall the actual board content needed to be.
    // `minHeight` keeps the same "fills at least the full viewport on a
    // short screen" look, but lets the column grow taller than 100vh when
    // real content (the now-un-shrunk map canvas) needs more room, so the
    // BROWSER's own page scrollbar carries the rest instead of an inner
    // pane's.
    minHeight: "100vh",
    width: "100%",
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
    backgroundColor: "#12141a",
    color: "#e6e8ef",
  },
  // Design note #12/item 5 (Upper Brand Header): fonts, badges, and wallet
  // fields all upscaled roughly 40-60% past their original small-print
  // sizes so the absolute topmost bar reads comfortably on a widescreen
  // panel, matching the same "fill the real estate" intent already applied
  // to the map/stock canvases.
  dashboard: {
    display: "flex",
    alignItems: "center",
    gap: "36px",
    padding: "16px 28px",
    backgroundColor: "#1a1d26",
    borderBottom: "1px solid #2a2e3a",
    flexWrap: "wrap",
  },
  dashboardBrand: {
    fontWeight: 700,
    fontSize: "28px",
    letterSpacing: "0.02em",
  },
  dashboardSection: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
  },
  dashboardLabel: {
    fontSize: "14px",
    color: "#9aa0ac",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  statusBadge: {
    fontSize: "14px",
    fontWeight: 600,
    padding: "5px 14px",
    borderRadius: "999px",
  },
  addressIndicator: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "15px",
    color: "#c7cbd4",
  },
  // VGP: no container, amber. Reads as a SCORE.
  vgpBalance: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "20px",
    fontWeight: 600,
    color: "#e0b64a",
  },
  // $JUNO: contained pill, teal, bordered. Reads as a REAL ASSET -- see the
  // comment at the render site for why the two are deliberately different
  // kinds of object rather than two rows of the same kind.
  nativeBalancePill: {
    display: "inline-flex",
    alignItems: "baseline",
    gap: "6px",
    padding: "4px 12px",
    borderRadius: "999px",
    border: "1px solid #2f6f6a",
    backgroundColor: "#14312f",
  },
  nativeBalanceAmount: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "20px",
    fontWeight: 600,
    color: "#5fd4c4",
  },
  nativeBalanceDenom: {
    fontSize: "12px",
    fontWeight: 700,
    letterSpacing: "0.06em",
    color: "#7fb3ad",
  },
  offlineBadge: {
    fontSize: "12px",
    fontWeight: 600,
    padding: "4px 10px",
    borderRadius: "6px",
    border: "1px solid #6b5a24",
    backgroundColor: "#2a2413",
    color: "#d9b95c",
    cursor: "help",
  },
  vgpBalanceNote: {
    fontSize: "13px",
    color: "#8a6d1f",
    maxWidth: "320px",
  },
  button: {
    fontSize: "15px",
    padding: "9px 18px",
    borderRadius: "8px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#242833",
    color: "#e6e8ef",
    cursor: "pointer",
  },
  errorText: {
    fontSize: "13px",
    color: "#e07a7a",
    maxWidth: "280px",
  },
  // ---- Main tabs -- see design note #9, upscaled by design note #12/item
  // 5 (Primary Navigation Tabs): bigger text and generous click padding so
  // "Rail Map" / "Stock Market" / "Financial Ledger" / "Rules Reference"
  // read as clear, comfortably-clickable primary navigation. ----
  // Design note #20/item 3: `#0F172A` background here matches
  // `TopTicker.tsx`'s own expanded-body slate, and `mainTabButtonActive`
  // below now shares `TopTicker.tsx`'s exact header color (`#1E293B`) --
  // together these let the active tab flow directly into the ticker
  // docked beneath it with no color seam or border line.
  mainTabBar: {
    display: "flex",
    gap: "6px",
    padding: "14px 28px 0",
    backgroundColor: "#0F172A",
  },
  mainTabButton: {
    fontSize: "17px",
    fontWeight: 700,
    padding: "14px 28px",
    borderRadius: "10px 10px 0 0",
    border: "1px solid #2a2e3a",
    borderBottom: "none",
    backgroundColor: "#1a1d26",
    color: "#9aa0ac",
    cursor: "pointer",
  },
  mainTabButtonActive: {
    backgroundColor: "#1E293B",
    color: "#e6e8ef",
    borderColor: "#1E293B",
  },
  // ---- Active Player Turn Notifications -- design note #18/item 4. A
  // full-viewport, `pointerEvents: "none"` overlay so the pulsing glow
  // reads as a page-level "your turn" signal around the viewport margin,
  // never intercepting clicks meant for the real UI underneath it. ----
  turnPulseOverlay: {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    pointerEvents: "none",
    zIndex: 800,
    animation: "app-turn-pulse-glow 1.6s ease-in-out infinite",
  },
  sidebarHint: {
    fontSize: "14px",
    color: "#6f7480",
    margin: "0 0 4px",
  },
  canvasPane: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    // Design note #13/item 1: was `overflow: "auto"` -- exactly the "tiny
    // panel box" internal scrollbar this item asks to remove. Dropped
    // outright: with no `overflow` set, this pane simply grows to its
    // content's real height (the board canvas's now-un-shrunk natural
    // size), same as any ordinary block content, and the page scrolls.
    padding: "20px",
  },
  // ---- Contextual Top Action Bar -- see design note #8/item 5, upscaled
  // by design note #12/item 5 (Gameplay Action Top Bar): larger button
  // font/padding and a taller bar overall so the dynamic header action
  // layout reads clearly at widescreen scale. ----
  actionBar: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "16px 20px",
    backgroundColor: "#1a1d26",
    border: "1px solid #2a2e3a",
    borderRadius: "10px",
  },
  // Active Player Turn Notifications -- design note #18/item 4. Spread onto
  // `actionBar` alongside its base style, not replacing it, so the bar's
  // own layout/padding/background are unaffected -- only the border color
  // and the shared pulsing-glow animation are added.
  actionBarTurnPulse: {
    borderColor: "#c0392b",
    animation: "app-turn-pulse-glow 1.6s ease-in-out infinite",
  },
  actionBarRoundLabel: {
    fontSize: "14px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "#9aa0ac",
  },
  actionBarButtons: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: "12px",
    flexWrap: "wrap",
  },
  actionBarButton: {
    fontSize: "16px",
    padding: "12px 20px",
    borderRadius: "10px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#242833",
    color: "#e6e8ef",
    cursor: "pointer",
  },
  actionBarUtilityButton: {
    color: "#c7cbd4",
    borderStyle: "dashed",
  },
  actionBarDivider: {
    width: "1px",
    alignSelf: "stretch",
    backgroundColor: "#2a2e3a",
    margin: "0 6px",
  },
  // ---- Manual Route Point UI -- see design note #11. ----
  routeToggleButtonActive: {
    borderColor: "#caa42a",
    backgroundColor: "#2a2410",
    color: "#f0d9a0",
  },
  routeToggleSwitchTrack: {
    display: "inline-flex",
    alignItems: "center",
    width: "30px",
    height: "16px",
    borderRadius: "999px",
    backgroundColor: "#3a3f4b",
    padding: "2px",
    marginRight: "10px",
    verticalAlign: "middle",
    boxSizing: "border-box",
  },
  routeToggleSwitchThumb: {
    width: "12px",
    height: "12px",
    borderRadius: "999px",
    backgroundColor: "#c7cbd4",
    transition: "transform 0.12s ease",
  },
  routeToggleSwitchThumbActive: {
    backgroundColor: "#caa42a",
    transform: "translateX(14px)",
  },
  routePanel: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    padding: "12px 14px",
    borderRadius: "8px",
    backgroundColor: "#161922",
    border: "1px dashed #3a3f4b",
  },
  routePanelHint: {
    fontSize: "13px",
    color: "#8a90a0",
    lineHeight: 1.4,
  },
  routePanelPath: {
    display: "flex",
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "6px",
  },
  routePanelEmpty: {
    fontSize: "14px",
    color: "#6f7480",
    fontStyle: "italic",
  },
  routePanelPoint: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "14px",
    fontWeight: 700,
    color: "#f4ecd8",
    padding: "4px 10px",
    borderRadius: "999px",
    backgroundColor: "#242833",
    border: "1px solid #3a3f4b",
  },
  routePanelArrow: {
    fontSize: "14px",
    color: "#6f7480",
  },
  routePanelMeta: {
    display: "flex",
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "12px",
  },
  routePanelHopCount: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "13px",
    color: "#9aa0ac",
  },
  routePanelHopCountExceeded: {
    color: "#ff8a75",
  },
  routePanelWarning: {
    fontSize: "13px",
    color: "#ff8a75",
  },
  routePanelClearButton: {
    fontSize: "13px",
    padding: "5px 12px",
    borderRadius: "8px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#242833",
    color: "#c7cbd4",
    cursor: "pointer",
  },
  // ---- Operating Round Phase 4 hardware marketplace tray -- see design
  // note #10/item 2, upscaled alongside the rest of the action bar (design
  // note #12/item 5). ----
  hardwareTray: {
    display: "flex",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: "10px",
  },
  hardwareTrayCard: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "4px",
    padding: "10px 16px",
    borderRadius: "8px",
    border: "1.5px solid #3a3f4b",
    backgroundColor: "#1a1d26",
    color: "#e6e8ef",
    cursor: "pointer",
    minWidth: "72px",
  },
  hardwareTrayCardSelected: {
    borderColor: "#caa42a",
    backgroundColor: "#2a2410",
  },
  hardwareTrayCardModel: {
    fontSize: "16px",
    fontWeight: 700,
  },
  hardwareTrayCardCost: {
    fontSize: "13px",
    color: "#9aa0ac",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  // ---- Buy Private Company Action Tray -- design note #14. ----
  privateCompanyTray: {
    display: "flex",
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "10px",
    padding: "10px 14px",
    borderRadius: "8px",
    border: "1.5px solid #3a3f4b",
    backgroundColor: "#1a1d26",
  },
  privateCompanyTrayLabel: {
    fontSize: "13px",
    color: "#9aa0ac",
    fontWeight: 600,
  },
  privateCompanySelect: {
    padding: "6px 10px",
    borderRadius: "6px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#242833",
    color: "#e6e8ef",
  },
  privateCompanyPriceRow: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: "8px",
  },
  privateCompanyPriceValue: {
    fontSize: "13px",
    color: "#e6e8ef",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    minWidth: "72px",
  },
  boardPane: {
    flex: 1,
    display: "flex",
    // Was "center"/"center" -- changed to "stretch" (design note #19/item 3
    // in HexGridRenderer.tsx) so `HexGridRenderer`/`StockMarketRenderer`
    // actually receive this pane's full available WIDTH to flex-fill,
    // instead of being centered at their own fixed content size.
    alignItems: "stretch",
    justifyContent: "stretch",
    // Design note #13/item 1: `overflow: "auto"` removed -- see
    // `canvasPane`'s own comment above for why. `StockMarketRenderer` (the
    // Stock Market tab, unaffected by this item) still gets its own
    // dedicated pane height from this same un-clipped flex chain; only the
    // Rail Map tab's canvas actually grows past one viewport in practice.
    minHeight: "420px",
  },
  hexClickIndicator: {
    position: "fixed",
    zIndex: 1000,
    maxWidth: "240px",
    padding: "8px 12px",
    borderRadius: "8px",
    backgroundColor: "#242833",
    border: "1px solid #3a3f4b",
    color: "#e6e8ef",
    fontSize: "12px",
    boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
  },
  hexClickIndicatorError: {
    backgroundColor: "#2a1414",
    borderColor: "#8a2020",
    color: "#ffe8e8",
  },
};
