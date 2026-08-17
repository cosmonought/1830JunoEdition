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
// 1. **RESOLVED (Step 4: Firebase Real-Time Integration).** This note used
//    to read "No game/room selection UI yet ... `gameId` stands in for
//    the currently open room ... swap it for real room state once that flow
//    exists." That flow now exists, and this is the swap.
//
//    `components/Lobby.tsx` is the room-selection screen, and `GameRouter`
//    at the bottom of this file is the boundary: with no room chosen it
//    renders the Lobby, and once a player is genuinely in a room's on-chain
//    roster it renders `AppShell` with a REAL `gameId` -- the `u64` the
//    contract itself assigned at `CreateGameRoom`, parsed from that
//    transaction's own `game_id` attribute (see `Lobby.tsx` design note #2).
//    Every `game_id` in every query and every `ExecuteMsg` below now comes
//    from that one prop.
//
//    `AppShell` also receives `roomId`, the FIRESTORE room id, which is a
//    different identifier serving a different system: `gameId` addresses the
//    contract, `roomId` addresses off-chain chat and presence. Both are
//    load-bearing and they are never interchangeable -- see design note #22.
// 22. **Firebase carries chat and presence ONLY (Step 4).** The strict
//    boundary, restated here because this file is where it would be
//    easiest to violate: the Juno contract remains the single source of
//    truth for game state, rules, board tiles, treasuries and turn
//    execution, and Firestore stores none of it. What changed in this file
//    is exactly two things, both transport-level:
//
//      - `chatMessages` is no longer `useState<ChatMessage[]>` fed by a
//        local `nextChatMessageId++` counter. It comes from
//        `useFirestoreChat(roomId, ...)`, so the chat half of the merged
//        feed is now genuinely multiplayer. `TopTicker`/`InlineQuickChat`
//        are UNCHANGED -- both already read from `mergeFeedItems` rather
//        than owning chat state, so replacing the transport underneath them
//        required no change to either component (see `ChatBox.tsx` design
//        note #0 for why no new chat panel was added).
//      - `usePresenceHeartbeat` runs for the whole session, so the table can
//        see when the active turn-holder has dropped. That is a UI hint with
//        no authority: the contract's own Inactivity Timeout Safety Valve is
//        the only thing permitted to have consequences for an absent player.
//
//    `actionLog` remains entirely local and on-chain-derived. It is NOT
//    written to Firestore -- it is this browser's record of transactions it
//    itself dispatched, and mirroring it would be the first step toward
//    treating an off-chain document as a game log.
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
//    the balance display, the Chatbox's turn-alert comparison, the
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
//    meaningful on the Rail Map tab.
//
//    **THE LIMITATION THAT USED TO STAND HERE IS RESOLVED (Step 4.5).** This
//    note previously read, correctly at the time: "this contract has NO
//    `ExecuteMsg`/`QueryMsg` that accepts or validates a caller-submitted
//    path at all... building one would be a genuine new contract feature,
//    not a frontend wiring gap." That feature was subsequently built.
//    `ExecuteMsg::RunManualRoute` validates a declared path step by step --
//    connectivity, the corporation's own station, rival token blockades, and
//    the train's distance budget -- and Batch 3 replaced its original
//    `hex_path: string[]` with `path: RouteWaypoint[]`, so a stop can name
//    WHICH station on a two-city hex it means. `handleRunTrains` now sends
//    the route the player actually built (via `routePointsToWaypoints`)
//    instead of discarding it, which is what this toggle was always for.
//
//    The client-side checks below remain, and are still worth having: they
//    catch a bad path before it costs a signature and a gas fee, rather than
//    duplicating the contract's authority. While active, `HexGridRenderer`'s existing `onHexClick` callback
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
//    Everything else a true validation needs -- whether each hop actually
//    follows laid track with a connecting edge, whether the path touches the
//    corporation's own station, whether a rival blockade sits in the way --
//    is checked ON-CHAIN by `RunManualRoute` and is deliberately NOT
//    reimplemented here. A second copy of those rules in TypeScript could
//    only drift from the authority, and the contract rejects a bad route
//    cleanly with a named error the Action Log already surfaces.
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
import { CosmWasmClient } from "@cosmjs/cosmwasm-stargate";

import { JUNO_RPC_ENDPOINT } from "./config";
import { GameSessionProvider, useGameSession } from "./context/GameSessionContext";
import HexGridRenderer, {
  type RouteOverlay,
  type MapGridResponse,
  type HexClickQueryState,
  type StationPreviewMarker,
} from "./components/HexGridRenderer";
import { liveEdgesForHex } from "./components/hexGeometry";
import { assignRouteSet, bridgeWaypoints } from "./utils/routeAutoTrace";
import { layableHexes, reachableNetwork } from "./utils/trackReach";
import { dividendDeclaration } from "./utils/dividendStep";
import { actingActor, countPhrase, describeGameplayAction } from "./utils/actionLog";
import { STATIC_BOARD_HEXES } from "./components/hexBoardData";
import {
  bestContrastTextColor,
  glowColorFor,
  stationTickerColor,
  // Design note #496: the fallback ticker for a corporation the live
  // response has not named, so the cursor still carries a herald.
  stationTickerLabel,
} from "./components/hexContractTypes";
import {
  type PrivateAbility,
  type PrivateAbilityAction,
} from "./components/PrivatePowerPanel";
import { corporationPrivateCompanies } from "./utils/gameState";
import type { TrainRouteDraft } from "./components/RoutePlannerPanel";
import {
  evaluateStationPlacement,
  nextStationTokenCost,
  placeableStationHexes,
  stationPlacementBlockReason,
  stationTokenSlots,
} from "./utils/stationTokens";
import { corporationFullName } from "./utils/corporationNames";
// Design note #494: one distinct ink per train, so overlapping routes are
// tellable apart. Shared with `RoutePlannerPanel`'s chips -- the same pure
// function on both surfaces rather than two tables.
import { routeEmphasisFor, routeTrainColor } from "./styles/routeLivery";
// Design note #522: the Sandbox multiplayer bridge.
import SandboxRoomBar from "./components/SandboxRoomBar";
import {
  appendSandboxAction,
  decodeAction,
  hostSandboxRoom,
  parseRoomCode,
  readSandboxLog,
  subscribeSandboxLog,
} from "./utils/sandboxRoom";
import { isFirebaseConfigured } from "./config/firebase";
import StockMarketRenderer, {
  marketCellForPrice,
  parBoxCellFor,
  projectDividendCellMove,
  projectDividendFrom,
  projectShareSaleMove,
  type MarketGridResponse,
} from "./components/StockMarketRenderer";
// Design note #162: `TileSelectionPopup` is no longer rendered or imported
// -- the radial selector replaced it, and its two callbacks went with it.
// The file is retained on disk, unreferenced, until the radial path has been
// exercised against a live chain.
import RadialTileSelector, { RadialTokenConfirm } from "./components/RadialTileSelector";
import {
  PrivateTradePrompt,
  ProposePrivatePurchase,
  type PrivateTradeProposal,
} from "./components/PrivateTradePanel";
import TopTicker from "./components/TopTicker";
import InlineQuickChat from "./components/InlineQuickChat";
import ContextualSubPanel from "./components/ContextualSubPanel";
import FinancialLedger from "./components/FinancialLedger";
import RulesReference from "./components/RulesReference";
import TrainTradePanel from "./components/TrainTradePanel";
/* Design note #508: the default export is gone from this import -- the panel
   is mounted by `ContextualActionBar` now, so this file supplies its props
   and no longer renders it. `TrainTradePrompt` still mounts here: it is the
   offer LEDGER, not the purchase control, and it never moved. */
import {
  TrainTradePrompt,
  type TrainTradeProposal,
} from "./components/TrainPurchasePanel";
import WaterfallAuctionDashboard from "./components/WaterfallAuctionDashboard";
import StockRoundPanel from "./components/StockRoundPanel";
import {
  useGameStatePolling,
  useTrainOffersPolling,
  useWaterfallStatePolling,
  type RoundType,
  type GameStateResponse,
  type WaterfallStateResponse,
  actingSeatIndex,
} from "./utils/gameState";
// Design note #22: `truncateChatAddress` and the `ChatMessage` type are no
// longer imported here. Both were only ever used to CONSTRUCT chat messages
// locally, and this file no longer constructs any -- `useFirestoreChat`
// returns them already built (and already labelled with a display name
// rather than a raw address, which is what `truncateChatAddress` was for).
import { mergeFeedItems, type ActionLogEntry, type FeedFilter } from "./utils/feed";
import {
  depotInventory,
  derivePhase,
  rustOutlook,
} from "./utils/gamePhase";
import { filterSandboxPlacements, isTokenableHex } from "./components/sandboxTileLegality";
import { describeTokenMigration, previewTokenMigration } from "./utils/tokenMigration";
import type { LegalTilePlacement } from "./components/hexContractTypes";
import {
  OPERATING_SUB_PHASE_LABELS,
  OPERATING_SUB_PHASE_ORDER,
  initialOrSubPhase,
  visibleSubPhases,
  type OperatingSubPhase,
} from "./components/OperatingSubPhaseStepper";
import { useDocumentTitleFlash } from "./utils/turnAlert";
import {
  placeParMark,
  sandboxInitialMarketPrices,
  sandboxMarketPriceTable,
  type SandboxMarketPrices,
  SANDBOX_PLAYERS,
  sandboxScenarioState,
  sandboxScenario,
  DEFAULT_SANDBOX_SCENARIO,
  type SandboxTrainFixture,
  type SandboxScenarioId,
  sandboxMarketPositions,
  sandboxPlayerLabel,
  sandboxWaterfallState,
} from "./utils/sandboxState";
import { availableCash, escrowedBids } from "./utils/auctionEscrow";
import { undoSkippedCount, undoTargetIndex } from "./utils/undoTarget";
import { privateHexFor } from "./utils/privateReservations";
import { GameOverModal, type GameEndReason } from "./components/GameOverModal";
import { bankIsBroken, rankPlayers, PLACEHOLDER_TOTAL_ANTE } from "./utils/endgame";

import {
  EmergencyTrainPurchaseModal,
  buildEmergencyPurchasePlan,
} from "./components/EmergencyTrainPurchaseModal";
import type { GameplayExecuteMsg } from "./utils/sessionKey";
import {
  applySandboxAction,
  applySandboxMarketAction,
  applyPrivateRevenue,
  applySandboxWaterfallAction,
  beginOperatingRound,
  pendingHomeTokens,
  placeHomeStationToken,
  describePrivatePayout,
  applySandboxLayTile,
  describeFloat,
  isRouteTerminusHex,
  grantBOPresidency,
  sandboxRouteBreakdown,
  SANDBOX_NOMINAL_TOKEN_COST,
} from "./utils/sandboxSession";
import SandboxToolbar from "./components/SandboxToolbar";
import BoParPrompt from "./components/BoParPrompt";
import HomeStationPrompt from "./components/HomeStationPrompt";
import ReturnToTurnBar from "./panels/ReturnToTurnBar";

// Step 4: Firebase Real-Time Integration -- see design notes #1 and #22.
import Lobby from "./components/Lobby";
import TutorialModal, {
  TutorialLibrary,
  OPERATING_ROUND_TUTORIAL,
  STOCK_MARKET_TUTORIAL,
  STOCK_ROUND_TUTORIAL,
  WATERFALL_AUCTION_TUTORIAL,
  TUTORIAL_LIBRARY,
  replayTutorials,
  tutorialModeEnabled,
} from "./components/TutorialModal";
import { useFirestoreChat } from "./components/ChatBox";
// NOT importing `truncateAddress` from `utils/lobby` -- `utils/address.ts`
// carries the version this file wants, the one with configurable lead/trail
// lengths, and importing the second would be a name collision. Two
// truncators is one too many, but unifying them is a separate tidy-up, not
// this pass's business.
import { loadDisplayName, usePresenceHeartbeat } from "./utils/lobby";

// ---- Extracted from this file; see design note #382 below. ----
import ContextualActionBar from "./panels/ContextualActionBar";
import TopBar from "./components/TopBar";
import MainTabBar, {
  isTabAvailable,
  surfaceTabFor,
  type MainTab,
} from "./components/MainTabBar";
import { styles } from "./styles/appStyles";
import { PHASE_SHIFT_PULSE_CSS, TURN_PULSE_KEYFRAMES_CSS } from "./styles/animations";
import {
  BO_PRIVATE_ID,
  BO_TICKER,
  buyStockProtocolId,
  ERA_FOR_PHASE_TINT,
  NO_TRAIN_ROUTE_REASON,
  SMALLEST_TRAIN_CAPACITY,
} from "./utils/gameConstants";
import {
  MOCK_BUY_STOCK_PAR_VALUE,
  MOCK_LAY_TILE_PROTOCOL_ID,
  MOCK_MAP_GRID,
  MOCK_MARKET_GRID,
  MOCK_TRAIN_CATALOG,
} from "./utils/mockFixtures";
import {
  axialHexDistance,
  routePointsToWaypoints,
  type RoutePoint,
  routeTokenBlockReason,
} from "./utils/routeWaypoints";
import {
  ACTIVE_GAME_STORAGE_KEY,
  readActiveGame,
  SANDBOX_GAME_ID,
  SANDBOX_ROOM_ID,
  type ActiveGame,
  type BoardMode,
} from "./utils/activeGame";
import { truncateAddress } from "./utils/address";

/* ==================================================================
 *  DESIGN NOTE 382: WHAT THIS FILE STOPPED BEING
 * ==================================================================
 *
 * `App.tsx` was 9,636 lines. The imports below are the visible half of a
 * move-only extraction that took roughly 3,500 of them out: nothing was
 * rewritten, no logic changed, and every moved declaration kept its own
 * design notes so their history reads as one file rename rather than as a
 * deletion here and an unrelated creation there.
 *
 * WHAT LEFT, and the rule that decided it: a declaration moved out if it
 * was ALREADY self-contained -- if it closed over nothing in `AppShell` and
 * could be lifted without threading a single new prop.
 *
 *   panels/ContextualActionBar.tsx   the 1,440-line round-aware control
 *                                    strip, with the four helpers that had
 *                                    no other consumer
 *   components/TopBar.tsx            wallet/session/room header
 *   components/MainTabBar.tsx        the tab strip AND the rules for which
 *                                    tabs exist
 *   styles/appStyles.ts              the 988-line shared style table
 *   styles/animations.ts             the `@keyframes` strings
 *   utils/gameConstants.ts           values that encode a rule
 *   utils/mockFixtures.ts            values that fake a chain query
 *   utils/routeWaypoints.ts          the manual route-point vocabulary
 *   utils/activeGame.ts              `BoardMode` and the stored room pointer
 *   utils/address.ts                 `truncateAddress`
 *
 * WHAT DELIBERATELY STAYED. `AppShell` itself, all 5,300 lines of it. Its
 * render tree could be cut into panels, but every one of those panels closes
 * over 40-80 locals, so the cut costs either an enormous prop list or a
 * context -- and either is a behavioural change wearing a refactor's
 * clothes. That is a separate pass with a separate risk budget. This one was
 * chosen precisely because it cannot change behaviour: the code that moved
 * is byte-identical to the code that was here.
 */


/* ------------------------------------------------------------------ */
/* Action Log -- entries constructed here, rendered via the combined     */
/* Feed Overlay (design note #18). `ActionLogEntry`/`ActionLogStatus`    */
/* themselves now live in utils/feed.ts -- see that file's design note   */
/* #1 for why.                                                           */
/* ------------------------------------------------------------------ */

let nextLogEntryId = 1;

// Design note #18/item 3's `nextChatMessageId` counter is REMOVED (design
// note #22). Chat message ids are now Firestore document ids -- globally
// unique and identical in every player's browser, which a per-client
// counter could never be. See `utils/feed.ts`'s `ChatMessage.id` for why
// that field was widened to `string | number` rather than the id being
// hashed back down into a number.

/* ------------------------------------------------------------------ */
/* App shell -- everything below here renders inside both providers   */
/* ------------------------------------------------------------------ */

interface AppShellProps {
  /** The CONTRACT's game id -- the `u64` assigned by `CreateGameRoom`.
   *  Every query and every `ExecuteMsg` below targets this.
   *
   *  Note this is now in the dependency array of every gameplay
   *  `useCallback` below. It did not used to be, and that was correct then
   *  and would be a bug now: `MOCK_GAME_ID` was a module-scope constant, so
   *  a closure over it could never go stale, whereas a prop can. `GameRouter`
   *  additionally keys `AppShell` on it, so in practice the component
   *  remounts rather than re-closing -- but a correct dependency array
   *  should not be load-bearing on a `key` prop two files away. */
  gameId: number;
  /** The FIRESTORE room id -- addresses off-chain chat and presence only.
   *  A different identifier for a different system; see design note #22. */
  roomId: string;
  /** Returns to the Lobby. */
  onLeaveGame: () => void;
  /** Which of the three ways of looking at a board this is -- design note
   *  #24. The two booleans below are derived from it inside the component;
   *  the mode is the single source so they cannot contradict each other. */
  mode: BoardMode;
}

function AppShell({ gameId, roomId, onLeaveGame, mode }: AppShellProps) {
  const wallet = useWallet();
  const session = useGameSession();

  /* ---------------- The two gates, derived from `mode` ---------------- */
  //
  // DESIGN NOTE #23 -- read-only mode is enforced at the DISPATCH sites,
  // not by disabling buttons. Hiding a control is a courtesy to the user;
  // refusing to dispatch is the guarantee, and only the second survives a
  // future pass adding a button without knowing spectators exist.
  //
  // This app has exactly TWO paths that can execute a gameplay message, and
  // read-only mode is only as good as its coverage of both:
  //
  //   1. `runGameplayAction` below -- the funnel for every button on the
  //      Contextual Action Bar, the Waterfall dashboard and the train-trade
  //      panel. Gated inside the function itself, so all ~20 controls are
  //      covered by one check.
  //   2. `TileSelectionPopup` -- calls `useGameSession().execGameplay`
  //      DIRECTLY (that component's own design note #1), so the gate in (1)
  //      does not apply to it. Covered by not mounting it when `spectator`.
  //
  // If a third dispatch path is ever added it must be gated too.
  // `grep -rn 'execGameplay('` over `src/` is the check, and it should
  // return exactly those two call sites.
  //
  // Belt and braces regardless: a spectator is not in the contract's
  // `player_addresses`, so the chain would reject anything they sent. These
  // gates make that refusal instant, free and legible rather than costing a
  // signature to discover.
  const spectator = mode === "spectate";

  // Design note #24. `sandbox` answers a different question from
  // `spectator`: not "may this viewer act?" but "is there a chain at all?".
  // Sandbox mode is emphatically NOT read-only -- the tile picker is the
  // main thing it exists to exercise -- it simply has nothing to talk to.
  const sandbox = mode === "sandbox";

  /* ==================================================================
   *  DESIGN NOTE 220: THE SANDBOX HAS NO SESSION KEY, AND NEVER WILL
   * ==================================================================
   *
   * REPORTED BUG: "the Buy Station Token button does not do anything -- it
   * does not change the cursor, nor does it allow placement."
   *
   * The button was fine. So was the cursor, and so was the click path. Every
   * control in the Contextual Action Bar renders
   * `disabled={btn.disabled || !sessionReady}`, and `sessionReady` was
   * `session.sessionStatus === "ready"` -- which becomes true only after a
   * player initialises an `x/authz` session key against a connected wallet.
   *
   * THE SANDBOX HAS NO WALLET BY CONSTRUCTION (design note #24: "not 'may
   * this viewer act?' but 'is there a chain at all?'"). `sessionStatus`
   * therefore sits at `"uninitialized"` forever, and every button in the bar
   * was permanently disabled. Not visibly so, either -- `actionBarButton`
   * carries no disabled styling of its own, because inline styles cannot
   * express `:disabled` (Lobby.tsx design note #3), so the controls looked
   * completely normal and silently swallowed every click.
   *
   * That explains a whole family of "this button does nothing" reports at
   * once, and it is why the same complaint kept coming back after the
   * handlers behind those buttons were fixed: the handlers were never
   * reached.
   *
   * The gate itself is right for a LIVE room -- dispatching without a
   * session key would fail at signing time. It is simply the wrong question
   * in the sandbox, where `runGameplayAction` short-circuits into the local
   * reducer and never signs, broadcasts or touches a wallet at all. One
   * derived value now asks the honest question -- "can this build dispatch
   * anything?" -- and every panel reads it, so the two cannot drift apart
   * again the way `TrainPurchasePanel` already had to work around locally.
   */
  const controlsEnabled = session.sessionStatus === "ready" || sandbox;

  /* ---------------- Sandbox phase toggle -- design note #25 ---------- */
  //
  // The sandbox could reach the rail map but nothing else. Both
  // phase-scoped panels mount on `gameState.current_round_type`, and with
  // no chain `gameState` is `null`, so the Waterfall Auction and the Stock
  // Round were unreachable -- not broken, just never rendered, with no way
  // to look at either.
  //
  // A DEBUG CONTROL, not a game mechanic. On a real chain the round type is
  // contract state advanced by `PassTurn` and the operating-round engine;
  // nothing in the UI may set it. This exists solely because the sandbox
  // has no contract to advance it, so the alternative is a screen that can
  // only ever depict one phase. It is rendered only when `sandbox` is true
  // and it feeds only `sandboxGameState` -- there is no code path by which
  // it can touch a real room's state.
  /* Design note #177 (SandboxToolbar): the sandbox testbed is chosen by
     SCENARIO now -- round type, era and train tier together -- because the
     three have to agree and picking only the round type left the era
     pinned to Green, which made the yellow and brown tile catalogs
     unreachable. `sandboxPhase` is derived from it so every existing reader
     is unchanged. */
  const [sandboxScenarioId, setSandboxScenarioId] =
    useState<SandboxScenarioId>(DEFAULT_SANDBOX_SCENARIO);
  const sandboxPhase = sandboxScenario(sandboxScenarioId).phase;
  /** Design note #9 in `sandboxState.ts`: the turn-1 fixture. */
  const sandboxIsZeroState = sandboxScenario(sandboxScenarioId).zeroState === true;

  /* ==================================================================
   *  DESIGN NOTE 301: A NEW GAME FORGETS THAT YOU HAVE PLAYED BEFORE
   * ==================================================================
   *
   * The zero-state scenario exists to be met the way a new player meets
   * the game, and the tutorials are part of that -- but their "seen" flags
   * live in `localStorage` and outlive every reset the scenario performs.
   * Anyone who has opened this sandbox once has dismissed the auction
   * explainer, so the one board built to show a first game was the one
   * board that never taught it.
   *
   * Cleared on ENTERING the zero state, which includes a page load that
   * starts there. That is deliberate rather than incidental: a new game is
   * exactly when a first-game explainer should be offered again, and the
   * mid-game fixtures leave the flags alone, so a tester hopping between
   * `or-green` and `stock` is not interrupted.
   *
   * `replayTutorials` rather than `resetTutorials` -- see design note #159
   * in `TutorialModal.tsx` for why the global off switch is left standing.
   * A player who has said "stop showing me these" has said it about the
   * app, not about this game. */
  useEffect(() => {
    if (!sandbox || !sandboxIsZeroState) return;
    replayTutorials(TUTORIAL_LIBRARY.map((topic) => topic.topicKey));
  }, [sandbox, sandboxIsZeroState, sandboxScenarioId]);

  /* Design note #1 in `PrivatePowerPanel.tsx`: which abilities have fired.
     Local, because there is no contract message to read it back from --
     the panel exists so the surface and its two gates are testable, and
     this is the smallest state that makes "Used" mean something. */
  const [usedPrivateAbilities, setUsedPrivateAbilities] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  /** Design note #303: what each private actually sold for, by id. */
  const [settledPrivatePrices, setSettledPrivatePrices] = useState<Readonly<Record<number, number>>>(
    {},
  );
  /** Design note #310: mirrored into a ref so the undo snapshot can capture
   *  it from inside the dispatch closure, the same reason `sandboxStateRef`
   *  exists. */
  const settledPrivatePricesRef = useRef<Readonly<Record<number, number>>>(settledPrivatePrices);
  useEffect(() => {
    settledPrivatePricesRef.current = settledPrivatePrices;
  }, [settledPrivatePrices]);

  /* Design note #246: which train distribution the fixture uses. A SECOND
     axis alongside the scenario, not a sixth scenario -- which era you are
     testing and who owns trains are independent questions. Seeded to the
     historic distribution so nothing changes until a tester asks. */
  const [sandboxTrainFixture, setSandboxTrainFixture] =
    useState<SandboxTrainFixture>("default");

  /* ===================================================================
   *  DESIGN NOTE 178: UNDO IS A SNAPSHOT STACK, AND ONLY IN SANDBOX
   * ===================================================================
   *
   * `sandboxSession.ts` refused to model undo, and its reasoning was right
   * for the place it was written: "undo is a full replay of the contract's
   * event log, and the sandbox has no log." A REDUCER cannot undo itself --
   * it sees one message and the state it produces, never the state it
   * replaced.
   *
   * But the owner of the state can. Every sandbox action goes through one
   * function, so pushing the OUTGOING state onto a stack before replacing
   * it costs one line and gives exact, unlimited, single-step undo -- no
   * inverse operation per message type, and therefore nothing to get wrong
   * per message type either.
   *
   * SANDBOX ONLY, and that is not a shortcut. On chain the contract owns
   * history; `UndoLastAction` is a real message and the server decides what
   * it means. Restoring a local snapshot there would desync the UI from the
   * chain, which is worse than an undo button that defers.
   *
   * The map grid rides along, because a tile lay changes both and undoing
   * one without the other would leave a tile on a board whose treasury had
   * never paid for it.
   *
   * ===================================================================
   *  DESIGN NOTE 310: THE SNAPSHOT HAS TO COVER EVERY ATOM AN ACTION MOVES
   * ===================================================================
   *
   * REPORTED: undo during the Auction breaks the turn cursor -- the bottom
   * panel says it is one player's turn while the hotseat gate thinks it is
   * another's, so seats get skipped and actions fire for the wrong player.
   *
   * The snapshot held `state`, `mapGrid` and `subPhase`, and the sandbox
   * keeps its game state in FOUR atoms, not one. `sandboxWaterfall` owns
   * `current_turn`, `mini_auction.current_turn` and `mini_auction.bidders`;
   * `sandboxMarket` owns the token positions; `settledPrivatePrices` owns
   * what each private actually sold for. None of the three were captured.
   *
   * So undo restored `active_player_index` (which is what the seating rail
   * and the round panels read) and left `waterfall.current_turn` where the
   * undone action had put it (which is what every control gate reads). The
   * two pointers are supposed to be the same fact; after one undo they were
   * one seat apart, and every subsequent action widened the gap.
   *
   * THE FIX IS THE SHAPE, NOT A PATCH. Rather than restoring the waterfall
   * cursor specifically -- which would leave the market and the settled
   * prices to be found the same way later -- the snapshot now carries every
   * piece of state the dispatch path writes. The rule to keep: if
   * `runGameplayAction` can change it, this record holds it.
   */
  const [, setSandboxHistory] = useState<
    Array<{
      state: GameStateResponse;
      mapGrid: MapGridResponse;
      subPhase: OperatingSubPhase;
      /** Design note #310: the auction's own atom, including both turn
       *  cursors and the mini-auction's bidder list. */
      waterfall: WaterfallStateResponse | null;
      market: SandboxMarketPrices;
      settledPrices: Readonly<Record<number, number>>;
      /** Design note #439: whether the action this snapshot precedes was
       *  dispatched BY THE GAME rather than by the player. Undo walks past
       *  these -- see `handleUndoLastAction`. */
      automatic: boolean;
      /* ==============================================================
       *  DESIGN NOTE 479: THE STACK REMEMBERS WHAT IT IS UNDOING
       * ==============================================================
       *
       * REPORTED: Undo logs "Reverted the last action" -- it should say
       * what was reverted.
       *
       * It could not, and the reason is worth stating because it is the
       * whole fix: a snapshot is a state, and a state does not know what
       * was done to it next. Reconstructing the action by DIFFING the
       * restored state against the discarded one would work for a tile lay
       * and fail for everything subtler, and would be a second, weaker
       * description of an event this app already writes one good sentence
       * about.
       *
       * So the sentence is captured at dispatch time and carried. The
       * snapshot is taken immediately before `msg` applies, which makes
       * `label` exactly the action Undo will reverse -- the same string
       * that went into the Activity Log when it happened, so the undo line
       * and the line it cancels quote each other.
       *
       * `actor` is stored separately rather than parsed back out of
       * `label`, because "PRR laid a yellow tile on B12" and "Carol bought
       * 10% of PRR" both begin with a name and only one of them begins
       * with the actor's. */
      label: string;
      actor: string;
    }>
  >([]);
  /** Bounded so a long hotseat session cannot grow the stack without limit.
   *  Deep enough that undo covers a whole corporation's turn. */
  const SANDBOX_HISTORY_LIMIT = 50;

  /* ---------------- Sandbox hotseat seat switcher -------------------- */
  //
  // Which of the four sandbox seats the client is currently pretending to
  // be, and whether that choice should track the game's own turn pointer.
  // See `SandboxToolbar` for the interaction design and why auto-follow
  // defaults on.
  const [sandboxSeatIndex, setSandboxSeatIndex] = useState(0);
  const [sandboxAutoFollow, setSandboxAutoFollow] = useState(true);

  /** Picking a seat by hand turns auto-follow OFF. The two settings are in
   *  direct conflict -- one says "show me whoever is up", the other says
   *  "show me Carol" -- and a manual pick that got overwritten on the next
   *  action would make the control useless for the only job it has. */
  const handleSelectSandboxSeat = useCallback((index: number) => {
    setSandboxSeatIndex(index);
    setSandboxAutoFollow(false);
  }, []);

  const handleToggleSandboxAutoFollow = useCallback(() => {
    setSandboxAutoFollow((previous) => !previous);
  }, []);

  /** Who the dashboard should think it is looking at.
   *
   *  Design note #25. In sandbox there is no wallet, so `wallet.address` is
   *  `null` -- and every turn-gated control on both phase panels compares
   *  the connected address against the active player. The result was a
   *  sandbox where the Auction and Stock Round rendered, but rendered
   *  entirely DISABLED, which is close to useless for judging layout: you
   *  cannot polish a control you can only see greyed out. Seating the
   *  viewer as the sandbox's first player (Alice, who `sandboxGameState`
   *  makes the active player in every phase) puts the panels in their live,
   *  enabled state.
   *
   *  READ-ONLY IDENTITY. This is used for DISPLAY and ENABLEMENT only --
   *  whose cash to show, whose holdings to mark "you", whether a control is
   *  live. It is deliberately NOT used for anything that signs: every
   *  dispatch still goes through `wallet.address`, and in sandbox
   *  `runGameplayAction` refuses before building a message at all. A
   *  pretend identity that could sign would be a genuinely dangerous
   *  shortcut; one that can only light up a button is not. */
  //  HOTSEAT UPDATE. This used to be hardcoded to `SANDBOX_PLAYERS[0]`, which
  //  worked exactly until the simulated turn moved off seat 0 -- at which
  //  point every turn-gated control on the dashboard went dead and stayed
  //  dead, because no wallet could ever become the active player. The seat is
  //  now switchable (see `SandboxToolbar`), so the whole loop is reachable
  //  solo.
  //
  //  The read-only caveat above is UNCHANGED and still load-bearing: this
  //  identity lights up controls and decides whose figures to show. It never
  //  signs. `runGameplayAction` still refuses to build a chain message in
  //  sandbox; it routes to the local reducer instead.
  const viewerAddress = sandbox
    ? (SANDBOX_PLAYERS[sandboxSeatIndex] ?? SANDBOX_PLAYERS[0])
    : wallet.address;


  // Design note #22. Read once at mount rather than subscribed to: the name
  // is set in the Lobby, before this component exists, and a rename
  // mid-game would (correctly) not rewrite the byline on messages already
  // sent -- `ChatBox.tsx` denormalises the name onto each message for
  // exactly that reason.
  const [displayName] = useState<string>(() => loadDisplayName() ?? "");

  // Design note #22: keeps this player's seat marked alive for the whole
  // session, so the rest of the table can see when the active turn-holder
  // has dropped rather than staring at a stalled board. A UI hint with no
  // authority -- the contract's Inactivity Timeout Safety Valve is the only
  // mechanism permitted to act on an absent player.
  //
  // Suppressed for spectators (design note #23): a spectator holds no seat
  // document, so a heartbeat would be an `updateDoc` against a path that
  // does not exist -- a guaranteed rejected write every 20 seconds. Passing
  // `null` disables the hook outright rather than relying on its
  // fire-and-forget `catch` to swallow the failure, which would work but
  // would be failing on purpose.
  // Sandbox has no Firestore room either (design note #24), so it joins
  // spectators in sitting this out.
  usePresenceHeartbeat(spectator || sandbox ? null : roomId, wallet.address);

  /* ---------------- Read-only query client -- design note #23 ---------- */
  //
  // A spectator has no wallet requirement, so there may be no
  // `signingClient` to query through -- and every live panel on this screen
  // reads through one. `useGameStatePolling` takes a structural
  // `QueryCapableClient` (just `queryContractSmart`), which a plain
  // `CosmWasmClient` satisfies without any signer, key or Keplr prompt.
  //
  // So: use the wallet's client when there is one (a player, or a spectator
  // who happens to be connected), and otherwise connect an anonymous
  // read-only client. This also quietly improves the PLAYER path -- the
  // board now renders before the wallet is connected instead of sitting
  // empty until it is.
  const [readOnlyClient, setReadOnlyClient] = useState<CosmWasmClient | null>(null);

  useEffect(() => {
    // A signing client is already query-capable; a second connection would
    // be pure waste.
    // Design note #24: sandbox never touches the network at all.
    if (sandbox) return undefined;
    if (wallet.signingClient) return undefined;
    // Offline Sandbox Mode: nothing to connect to, and this must not throw
    // (config.ts design note #0), so read the raw value rather than
    // `requireRpcEndpoint()`.
    if (!JUNO_RPC_ENDPOINT) return undefined;

    let cancelled = false;
    CosmWasmClient.connect(JUNO_RPC_ENDPOINT)
      .then((client) => {
        // The guard matters: without it, a connection resolving after the
        // user has navigated back to the lobby sets state on an unmounted
        // component, and worse, a wallet connecting mid-flight would leave
        // this stale client racing the real one.
        if (!cancelled) setReadOnlyClient(client);
      })
      .catch(() => {
        // Unreachable RPC. The polls simply report no state and every panel
        // shows its own empty/error affordance -- there is nothing useful to
        // add here that they do not already say.
      });

    return () => {
      cancelled = true;
    };
  }, [wallet.signingClient, sandbox]);

  /** The single client every live query on this screen reads through.
   *
   *  `undefined` in sandbox, which stops every poll on this screen at
   *  source (`useGameStatePolling` treats a missing client as offline and
   *  simply never queries). Panels then render their own empty states,
   *  which is the honest depiction of a board with no chain behind it. */
  const queryClient = sandbox ? undefined : (wallet.signingClient ?? readOnlyClient ?? undefined);

  const [actionLog, setActionLog] = useState<ActionLogEntry[]>([]);
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

  // Stock Round (SR) control state -- see `StockRoundPanel.tsx` design
  // note #1. Purely UI state; the real dispatch runs through
  // `handleBuyShare`/`handleSellShares` below.
  //
  // Design note #29: `srSelectedProtocolId` is GONE. It held "which company
  // the single set of Stock Round controls is pointed at", and there is no
  // single set any more -- every corporation card carries its own Buy and
  // Sell, and passes its own id to the handler. Keeping a shared selection
  // alongside eight per-card actions would be a second, contradictory
  // answer to "which company?" waiting to be read by mistake.
  /* ==================================================================
   *  DESIGN NOTE 398: ONE PAR SELECTION PER CORPORATION
   * ==================================================================
   *
   * REPORTED: selecting a par value on one corporation's tile updates the
   * par selector for all corporations, and for all players.
   *
   * It did, and the cause is the shape of this state rather than anything
   * in the cards: `srParValue` was ONE string, threaded into all eight
   * ladders as `parValue` and back out through one `onSelectParValue`. Every
   * ladder was therefore a view of the same value, so pressing $90 on the
   * PRR moved the highlight on the B&O, the C&O and everything else -- and
   * because the dispatch read that single value, the NEXT president's
   * purchase carried a price somebody else had chosen for a different
   * company.
   *
   * This is precisely the bug design note #18 in `StockRoundPanel.tsx` fixed
   * for the buy SOURCE, which was also one value shared across eight cards.
   * That note's own words: "the toggle a player set on PRR silently governed
   * the purchase they then made from B&M." Par is the same failure with
   * worse consequences, because par is not a preference -- it is the price
   * the certificate is bought at, and it is set once and permanently.
   *
   * KEYED BY `company_id`, not by index: the roster's order is the
   * contract's and a company can be absent from a partial response, so an
   * index would silently re-point one company's par at another's.
   *
   * THE DEFAULT IS NOT STORED. A company with no entry falls back to
   * `MOCK_BUY_STOCK_PAR_VALUE` at read time, so the map holds only genuine
   * choices -- which keeps "has this player picked a par for this company"
   * answerable, and means seeding eight defaults is not a prerequisite for
   * rendering.
   *
   * "AND FOR ALL PLAYERS" is the same single-value bug seen from the other
   * side, and it is fixed by the same change in the hotseat: the map is
   * cleared when the acting seat changes (see the effect below), so an
   * incoming player never inherits the outgoing player's half-made choice.
   */
  /* Design note #399: the B&O private is won in the auction and owes its
     winner a presidency AND a price. Held here until the prompt is answered,
     because the certificate must not be granted without one. */
  const [boParPrompt, setBoParPrompt] = useState<{ player: string } | null>(null);
  const [srParValues, setSrParValues] = useState<Readonly<Record<number, string>>>({});
  const parValueFor = useCallback(
    (companyId: number): string => srParValues[companyId] ?? MOCK_BUY_STOCK_PAR_VALUE,
    [srParValues],
  );
  const handleSelectParValue = useCallback((companyId: number, value: string) => {
    setSrParValues((prev) => ({ ...prev, [companyId]: value }));
  }, []);
  /** Design note #351/#398: mirrored so the dispatch path can read a
   *  selection synchronously, the same reason `sandboxStateRef` exists. Now
   *  a map, because "the ladder's current selection" is a question that only
   *  has an answer once you say WHICH ladder. */
  const srParValuesRef = useRef<Readonly<Record<number, string>>>(srParValues);
  useEffect(() => {
    srParValuesRef.current = srParValues;
  }, [srParValues]);
  const parValueNumberFor = useCallback((companyId: number): number | null => {
    const parsed = Number(srParValuesRef.current[companyId] ?? MOCK_BUY_STOCK_PAR_VALUE);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }, []);

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
    gameState: liveGameState,
    loading: gameStateLoading,
    error: gameStateError,
    refresh: refreshGameState,
  } = useGameStatePolling(queryClient, CONTRACT_ADDRESS, gameId);

  // Design note #25: in sandbox the poll above is permanently `null` (no
  // client), so a hand-authored snapshot stands in. Everything downstream
  // reads `gameState` and is completely unaware of the substitution --
  // which is the point: the panels are being inspected as they will really
  // behave, not through a sandbox-only rendering path that could drift from
  // the real one.
  //
  // Memoised because `gameState` sits in the dependency array of a dozen
  // hooks below. Rebuilding the object every render would give it a new
  // identity each time and re-fire all of them continuously.
  // Hotseat sandbox: this used to be a `useMemo` recomputed from the phase,
  // which made it immutable by construction -- every dispatched action had
  // nowhere to write, so the sandbox could only ever depict one frozen
  // moment. It is now real state, seeded from the same fixture and advanced
  // by `applySandboxAction`.
  //
  // The seeding effect below keys on the phase toggle: switching phase is a
  // DEBUG action meaning "show me that screen", so it deliberately discards
  // whatever the hotseat loop had accumulated and starts that phase clean.
  // Preserving mutations across a phase jump would produce states the real
  // game can never reach.
  const [sandboxState, setSandboxState] = useState<GameStateResponse | null>(() =>
    sandbox ? sandboxScenarioState(sandboxScenarioId, gameId, sandboxTrainFixture) : null,
  );

  /* Design note #265: a synchronous mirror of the two sandbox atoms.
   *
   * `useState` values do not refresh inside one synchronous block, which
   * broke two things: a loop of dispatches (the multi-train purchase) applied
   * every message to the same base state, and the auction's charge was read
   * from one hook's updater before another hook's updater had written it.
   * A ref is written at dispatch time, so each action sees the last one's
   * result and the log can describe what actually resulted.
   *
   * The state remains the RENDERING source of truth -- the ref exists so the
   * dispatch path has something to read, not so components can bypass
   * React. Both are written together, always. */
  const sandboxStateRef = useRef<GameStateResponse | null>(null);
  const sandboxWaterfallRef = useRef<WaterfallStateResponse | null>(null);
  useEffect(() => {
    sandboxStateRef.current = sandboxState;
  }, [sandboxState]);
  useEffect(() => {
    setSandboxState(
      sandbox ? sandboxScenarioState(sandboxScenarioId, gameId, sandboxTrainFixture) : null,
    );
    // Switching scenario is a fresh testbed: drop any in-flight preview,
    // selector or undo history rather than carrying state from a board that
    // no longer exists.
    setSandboxHistory([]);
    /* ===================================================================
     *  DESIGN NOTE 330: A NEW BOARD GETS A NEW LOG
     * ===================================================================
     *
     * REPORTED: switching to the Zero State scenario leaves residual
     * activity log entries from previous sandbox runs.
     *
     * It did, and the Zero State is where it is most obviously wrong --
     * that scenario's entire claim is that it is a game before anything has
     * happened, and it opened with a log describing a route somebody ran on
     * a board that no longer exists. But the bug is not specific to it: the
     * log is a ledger OF ONE BOARD, and every scenario switch replaces the
     * board. An entry saying "PRR bought a 4-train for $300" is not merely
     * stale after the switch, it is false -- there is no such PRR any more,
     * and its treasury reads whatever the new fixture seeds.
     *
     * The three session-residue atoms go with it, for the same reason and
     * with a sharper symptom each:
     *
     *   `settledPrivatePrices`  a fresh auction would show "Sold to Carol
     *                           for $145" on a private nobody has bid on.
     *   `usedPrivateAbilities`  a fresh board would show "Used" on a power
     *                           whose owner does not own it yet.
     *   `actionLog`             the report above.
     *
     * GUARDED ON `sandbox`, and the guard is load-bearing rather than
     * defensive. This effect also depends on `gameId`, which changes on a
     * LIVE chain when the player opens a different room -- so an unguarded
     * purge would wipe a log of blocks that really happened, which is the
     * opposite of this fix. Sandbox logs describe a fixture; chain logs
     * describe history. */
    if (sandbox) {
      setActionLog([]);
      setSettledPrivatePrices({});
      setUsedPrivateAbilities(new Set<string>());
    }
    // Design note #246: flipping the trade fixture re-seeds too. It changes
    // who owns what, which is board state rather than a view setting, so
    // applying it to a board mid-hotseat would leave trains appearing in
    // rosters with no action having created them.
  }, [sandbox, sandboxScenarioId, sandboxTrainFixture, gameId]);

  const gameState = sandboxState ?? liveGameState;

  // Design note #36: derived, not queried -- see `utils/gamePhase.ts`
  // design note #1 for why `current_global_era` cannot answer this.
  //
  // DECLARED HERE, above `runGameplayAction`, rather than down with the
  // other render-time derivations: that callback's sandbox branch prices a
  // route from the board and the era, so both must exist by the time it is
  // constructed. `const` bindings are not hoisted, and the callback closes
  // over them directly rather than through a ref.
  const currentPhase = useMemo(() => derivePhase(gameState), [gameState]);

  /* ===================================================================
   *  DESIGN NOTE 169: ACT AS THE CORPORATION WHOSE TURN IT IS
   * ===================================================================
   *
   * Every Operating Round action in this file targeted
   * `MOCK_LAY_TILE_PROTOCOL_ID` -- a hardcoded `4`, chosen as a stand-in
   * long before there was a turn queue to consult. The sandbox fixture
   * meanwhile opens its Operating Round on `active_operating_order[0]`,
   * which is protocol 1 (PRR).
   *
   * So the UI was acting AS B&O while the turn belonged to PRR, and the two
   * disagreements that produced are exactly the reported lockout:
   *
   *   - `LayTile` and every other OR dispatch named the wrong corporation.
   *     On chain that is `NotYourOperatingTurn`. In sandbox it charged B&O's
   *     treasury -- which is `0`, because B&O is `floated: false` and has
   *     never been capitalised.
   *   - The Buy Private sheet read B&O's treasury to decide what the
   *     corporation could afford, and got zero.
   *
   * THE PRESIDENCIES WERE NEVER MISSING. `sandboxState.ts` assigns one to
   * every corporation and maps it through `SANDBOX_PLAYERS[corp.president]`,
   * so `actingSeatIndex` resolved PRR's president (Alice, seat 0) correctly
   * all along, and auto-follow moved the hotseat to her. The identity that
   * was wrong was the CORPORATION's, not the player's.
   *
   * Derived from the queue, with the old constant as the fallback for a
   * room whose Operating Round has not been started yet (an empty
   * `active_operating_order`), so nothing that previously rendered starts
   * rendering `undefined`. */
  const actingProtocolId = useMemo(() => {
    const queued = gameState?.active_operating_order[gameState.active_corporation_index];
    return queued ?? MOCK_LAY_TILE_PROTOCOL_ID;
  }, [gameState]);

  // Design note #144: drives the Routes skip button's disabled state. The
  // contract refuses that skip for any corporation owning a train, so the
  // button is disabled with the reason rather than dispatching a transaction
  // that is certain to be rejected.
  /** The whole depot, tier by tier -- `depotInventory` already applies
   *  1830's cheapest-first queue rule and the remaining-stock arithmetic
   *  (its design note #4), so `TrainPurchasePanel` renders it rather than
   *  deriving a second answer.
   *
   *  Design note #203: this used to be narrowed to the ONE purchasable tier
   *  before it left this component, which is what the old one-card tray
   *  needed. The panel shows every tier -- a player deciding whether to buy
   *  the depot's last 3-train needs to see what a 4-train costs and which
   *  tier is about to rust, and both are facts about tiers they cannot
   *  currently buy. */
  const depot = useMemo(() => depotInventory(gameState), [gameState]);

  const ownsAnyTrain = useMemo(() => {
    const company = gameState?.public_companies.find(
      (entry) => entry.company_id === actingProtocolId,
    );
    // Audit G-15c closed the gap this used to stub out: `owned_trains` now
    // arrives on `PublicCompanyState`, so the Routes skip button can be
    // disabled for a corporation that genuinely holds a train.
    //
    // `undefined` still means "this chain does not say" (a contract predating
    // the field), NOT "owns nothing" -- in that case report `false`, leaving
    // the skip enabled and the contract as the authority. Erring the other
    // way would disable a legal skip with no override.
    return (company?.owned_trains?.length ?? 0) > 0;
  }, [gameState, actingProtocolId]);

  /* ==================================================================
   *  DESIGN NOTE 293b: "OWNS NONE" IS NOT "WE WERE NOT TOLD"
   * ==================================================================
   *
   * `ownsAnyTrain` above reports `false` for a chain that does not carry
   * `owned_trains`, and its own note explains why that is the safe
   * direction THERE: it leaves a skip enabled and the contract as the
   * authority.
   *
   * It is the unsafe direction here. This gates END TURN, so reading
   * "unknown" as "owns none" would lock a corporation's turn against a
   * contract that never said anything -- a deadlock with no override, on
   * the one control that ends the turn.
   *
   * The two questions therefore get two values. The obligation only exists
   * when the roster is REPORTED and EMPTY; ignorance permits, because the
   * cost of a wrong "must buy" is a stuck game and the cost of a wrong
   * "may leave" is a move the contract will refuse on its own. */
  const trainlessAndReported = useMemo(() => {
    const company = gameState?.public_companies.find(
      (entry) => entry.company_id === actingProtocolId,
    );
    const owned = company?.owned_trains;
    if (owned == null) return false;
    return owned.length === 0;
  }, [gameState, actingProtocolId]);


  /* ==================================================================
   *  DESIGN NOTE 207: THE TRAIN BEING RUN IS OBSERVED, NOT PICKED
   * ==================================================================
   *
   * This was `useState(MOCK_TRAIN_CATALOG[0].modelType)` -- a 2-train,
   * always, with a setter wired to a tray selector that design note #182
   * removed. So the route builder's capacity readout said "max 2 stops
   * (2-train)" for a corporation running a 5, and `handleAutoRoute` would
   * have drafted to the wrong cap.
   *
   * The best train a corporation OWNS is the honest answer and needs no
   * control at all: a player running trains runs their biggest one, and if
   * they own none there is nothing to run. Derived rather than selected also
   * means it cannot go stale after a purchase.
   *
   * `MOCK_TRAIN_CATALOG`'s ORDER is the tier order, so the highest index a
   * corporation holds is its best train. Falling back to the first entry
   * when it owns nothing keeps the readout showing a real limit instead of
   * blanking -- and a corporation with no train cannot reach the Routes step
   * with anything to declare anyway. */
  /* ==================================================================
   *  DESIGN NOTE 227: THE PLAYER PICKS THE TRAIN, NOT THE APP
   * ==================================================================
   *
   * Design note #207 replaced a broken `useState` (stuck on "2-train"
   * forever) with the corporation's BEST owned train, derived. That was the
   * right fix for the readout being wrong, and the wrong shape for the
   * feature: a corporation routinely owns several trains and runs each of
   * them on its own route, so "which train is this path for" is a choice the
   * player makes, not a fact the app can observe.
   *
   * It matters mechanically, not just cosmetically -- the train's number is
   * the cap on how many revenue centres the route may visit, so charting a
   * path for a 3-train while the builder validates against a 5 lets a player
   * assemble a route the contract will refuse.
   *
   * So the selection is STATE again, seeded from the best train and reset
   * whenever the acting corporation changes. The derivation survives as the
   * DEFAULT rather than as the answer: opening the builder on a corporation's
   * biggest train is the common case, and the selector is there for the rest.
   *
   * `null` means "not chosen yet", which the resolver below turns into the
   * default. Storing the default eagerly would make it impossible to tell a
   * deliberate pick from a stale one after the corporation changed.
   */
  const bestOwnedTrain = useMemo(() => {
    const owned =
      gameState?.public_companies.find((company) => company.company_id === actingProtocolId)
        ?.owned_trains ?? [];
    let best = MOCK_TRAIN_CATALOG[0].modelType;
    let bestIndex = -1;
    for (const model of owned) {
      // `MOCK_TRAIN_CATALOG`'s ORDER is the tier order, so the highest index
      // a corporation holds is its best train.
      const index = MOCK_TRAIN_CATALOG.findIndex((train) => train.modelType === model);
      if (index > bestIndex) {
        bestIndex = index;
        best = model;
      }
    }
    return best;
  }, [gameState, actingProtocolId]);

  /* ==================================================================
   *  DESIGN NOTE 275: THE ROSTER, NOT THE SET OF MODELS
   * ==================================================================
   *
   * This used to deduplicate -- "two 3-trains are one CHOICE, and offering
   * '3' and '3' would be two buttons that do the same thing". That was
   * right about the old question and wrong about the game: the two buttons
   * do NOT do the same thing once each train is drafting its own route.
   * Three 3-trains are three trains, three routes and three chips.
   *
   * Ordered by tier so the roster reads big-train-first, and carrying the
   * INDEX because that is the only thing telling one 3-train from another.
   */
  const ownedTrainRoster = useMemo(() => {
    const owned =
      gameState?.public_companies.find((company) => company.company_id === actingProtocolId)
        ?.owned_trains ?? [];
    const rank = (model: string) =>
      MOCK_TRAIN_CATALOG.findIndex((train) => train.modelType === model);
    return owned
      .map((model, ownedIndex) => ({
        // Design note #275: the identity. Stable against re-sorting below,
        // because it is the position in `owned_trains` rather than here.
        trainIndex: ownedIndex,
        model,
        maxDistance: MOCK_TRAIN_CATALOG.find((train) => train.modelType === model)?.maxDistance,
      }))
      // Unknown models sort last rather than to the front, which is where a
      // `-1` from `findIndex` would otherwise put them.
      .sort((a, b) => (rank(a.model) < 0 ? 99 : rank(a.model)) - (rank(b.model) < 0 ? 99 : rank(b.model)));
  }, [gameState, actingProtocolId]);

  /** Design note #228: the acting corporation, resolved once for the
   *  Operating Round context strip.
   *
   *  STATIONS LEFT is `station_token_limit` minus the tokens already on the
   *  board, which is the figure the player needs -- the limit alone answers
   *  a question nobody asks. Floored at zero rather than allowed negative:
   *  a chain reporting more placed tokens than the limit is a contract bug,
   *  and rendering "-1 stations" would report it as a UI one. */
  const activeCorporationContext = useMemo(() => {
    const company = gameState?.public_companies.find(
      (entry) => entry.company_id === actingProtocolId,
    );
    if (!company) return null;
    return {
      companyId: company.company_id,
      ticker: company.ticker,
      fullName: corporationFullName(company.ticker) ?? null,
      /** Design note #362: the printed home hex, for the token row. */
      homeHexLabel: company.home_hex_label ?? null,
      /** Design note #379: privates this corporation's TREASURY owns --
       *  bought from a player under the phase-gated corporate purchase, and
       *  until now visible on no surface at all. */
      privates: gameState
        ? corporationPrivateCompanies(company.company_id, gameState)
        : [],
      presidentLabel: company.president
        ? (sandboxPlayerLabel(company.president) ?? truncateAddress(company.president))
        : null,
      // Design note #441: the identity, for the corporate-power gate.
      presidentAddress: company.president ?? null,
      /** Design note #326: the president's OWN wallet, not the treasury.
       *  `null` when there is no president or the room does not report their
       *  cash -- the tooltip is then omitted entirely rather than promising
       *  a figure it does not have. */
      presidentCash: company.president
        ? (() => {
            const entry = gameState?.player_cash.find((row) => row.player === company.president);
            const value = entry ? Number(entry.cash_vgp) : NaN;
            return Number.isFinite(value) ? value : null;
          })()
        : null,
      treasury: Number(company.treasury) || 0,
      // Design note #237: the row needs every token and its own price, not a
      // remaining-count. `stationTokenSlots` owns 1830's schedule.
      stationSlots: stationTokenSlots(company),
      trains: company.owned_trains ?? [],
    };
  }, [gameState, actingProtocolId]);

  /** Design note #237: what the NEXT station token costs THIS corporation.
   *
   *  Was the flat `SANDBOX_NOMINAL_TOKEN_COST` -- $40 for every placement,
   *  forever. 1830 charges nothing for the home token, $40 for the second
   *  and $100 for every one after, so the constant was correct exactly once
   *  per corporation and understated the third by 60%.
   *
   *  `null` means the allowance is spent. The button falls back to the
   *  second-token price for its label in that state rather than printing
   *  "$null" -- it is disabled by the placement check either way, and a
   *  disabled control showing a plausible figure beats one showing a hole. */
  const activeStationCompany = gameState?.public_companies.find(
    (company) => company.company_id === actingProtocolId,
  );
  const stationTokenCost =
    nextStationTokenCost(activeStationCompany) ?? SANDBOX_NOMINAL_TOKEN_COST;

  const [pickedRouteTrain, setPickedRouteTrain] = useState<string | null>(null);

  // A pick belongs to the corporation that made it. Clearing on a change of
  // acting corporation stops a 5-train selection surviving onto a company
  // that owns nothing bigger than a 3 -- which would silently validate the
  // next player's route against a train they do not have.
  useEffect(() => {
    setPickedRouteTrain(null);
  }, [actingProtocolId]);

  const selectedHardwareModel =
    pickedRouteTrain !== null && ownedTrainRoster.some((t) => t.model === pickedRouteTrain)
      ? pickedRouteTrain
      : bestOwnedTrain;

  // The live board. STATE, not `useMemo`, so `applySandboxLayTile` can
  // replace it with a NEW object -- that identity change is what
  // `HexGridRenderer`'s draw effect watches, and mutating `tiles` in place
  // would leave the reference untouched and the canvas would never repaint.
  const [mapGrid, setMapGrid] = useState<MapGridResponse>(MOCK_MAP_GRID);

  // Auto-Follow Turn. Moves the simulated seat to whoever may actually act,
  // which is a PHASE-DEPENDENT question and not simply
  // `active_player_index`:
  //
  //   - Waterfall Auction / Stock Round: seats act in order, so the turn
  //     pointer is the answer.
  //   - Operating Round: the queue names CORPORATIONS, and the human who may
  //     act is whoever presides over the one currently up. The seat pointer
  //     is not meaningful here and routinely points at a player with nothing
  //     to do.
  //
  // `actingSeatIndex` owns that distinction. It returns `null` when the seat
  // cannot be resolved -- an Operating Round whose current corporation has no
  // president -- and the seat is then deliberately left where it is rather
  // than reset to zero, which would yank the view away mid-inspection.
  useEffect(() => {
    if (!sandbox || !sandboxAutoFollow || !sandboxState) return;
    const next = actingSeatIndex(sandboxState);
    if (next === null) return;
    setSandboxSeatIndex((current) => (current === next ? current : next));
  }, [sandbox, sandboxAutoFollow, sandboxState]);

  // Pre-Game Waterfall Auction (`waterfall.rs`): a second, independent poll
  // against `QueryMsg::GetWaterfallState`, only actually enabled while
  // `gameState.current_round_type === "WaterfallAuction"` -- see
  // `utils/gameState.ts` design note #7. `WaterfallAuctionDashboard` below
  // is the only consumer.
  const isWaterfallPhase = gameState?.current_round_type === "WaterfallAuction";
  // Audit G-15: pending corporation-to-corporation train offers. Polled
  // separately from the board because a SELLER must see an offer arrive while
  // it is emphatically not their turn -- this cannot key off turn state.
  const { offers: trainOffers, refresh: refreshTrainOffers } = useTrainOffersPolling(
    queryClient,
    CONTRACT_ADDRESS,
    gameId,
  );

  const {
    waterfallState: liveWaterfallState,
    loading: waterfallStateLoading,
    error: waterfallStateError,
  } = useWaterfallStatePolling(
    queryClient,
    CONTRACT_ADDRESS,
    gameId,
    isWaterfallPhase,
  );

  /* ==================================================================
   *  DESIGN NOTE 261: THE AUCTION NEEDED TO BE STATE, NOT A MEMO
   * ==================================================================
   *
   * REPORTED: no Auction button does anything.
   *
   * This was a `useMemo` over `(sandbox, sandboxPhase, gameId)` -- so the
   * dashboard re-rendered the same frozen fixture after every click, and the
   * five auction handlers dispatched into a reducer that had no arm for the
   * response shape they affect. Two halves of one gap: no place to put a
   * change, and nothing computing one.
   *
   * It is STATE now, seeded from the same fixture and advanced by
   * `applySandboxWaterfallAction`. Re-seeded on a scenario or phase change
   * for exactly the reason the game state is (design note #25): switching
   * scenario means "show me that screen", not "carry my half-finished
   * auction into it".
   */
  const [sandboxWaterfall, setSandboxWaterfall] = useState<WaterfallStateResponse | null>(
    () => (sandbox ? sandboxWaterfallState(sandboxPhase, gameId, sandboxIsZeroState) : null),
  );
  useEffect(() => {
    setSandboxWaterfall(sandbox ? sandboxWaterfallState(sandboxPhase, gameId, sandboxIsZeroState) : null);
  }, [sandbox, sandboxPhase, gameId, sandboxIsZeroState]);
  useEffect(() => {
    sandboxWaterfallRef.current = sandboxWaterfall;
  }, [sandboxWaterfall]);

  /* Design note #272: the third sandbox atom. The chart used to be a frozen
     `useMemo` over the fixture table, so no trade could ever move a token;
     it is state now, advanced by `applySandboxMarketAction` on the same
     dispatch that advances the other two. Same ref treatment as the other
     two, for design note #265's reason -- a loop of dispatches must see
     each other's results. */
  const [sandboxMarket, setSandboxMarket] = useState<SandboxMarketPrices>(() =>
    // Design note #387: the Zero State seeds an EMPTY chart. Nothing is
    // parred at turn one, so nothing has a market position.
    sandboxInitialMarketPrices(
      marketCellForPrice,
      parBoxCellFor,
      sandboxScenario(sandboxScenarioId).zeroState,
    ),
  );
  // Re-seeded on a scenario change for the same reason the other two are:
  // picking a scenario means "show me that screen", not "carry my moved
  // tokens into it".
  useEffect(() => {
    setSandboxMarket(
      sandboxInitialMarketPrices(
      marketCellForPrice,
      parBoxCellFor,
      sandboxScenario(sandboxScenarioId).zeroState,
    ),
    );
  }, [sandbox, sandboxScenarioId, gameId]);
  const sandboxMarketRef = useRef<SandboxMarketPrices>(sandboxMarket);
  useEffect(() => {
    sandboxMarketRef.current = sandboxMarket;
  }, [sandboxMarket]);

  /* Design note #2 in `sandboxState.ts`: the cards want prices, the chart
     wants cells, and both now come off the same object so they cannot
     disagree again. */
  const sandboxMarketPrices = useMemo(
    () => sandboxMarketPriceTable(sandboxMarket),
    [sandboxMarket],
  );

  /** Design note #411: one corporation's current chart price, for building
   *  the Operating Round queue.
   *
   *  READS THE REF, NOT THE MEMO. `runGameplayAction` refreshes
   *  `sandboxMarketRef` partway through a dispatch and then advances the
   *  game state; a lookup closed over `sandboxMarketPrices` would be a
   *  render behind at exactly that moment and could order the queue on
   *  prices the same dispatch had already changed. Stable identity, so it
   *  does not re-arm every consumer on each market tick. */
  const marketPriceForCompany = useCallback(
    (companyId: number): number | null => sandboxMarketRef.current[companyId]?.price ?? null,
    [],
  );

  /** Design note #363: the board's own label -> `(q, r)` table.
   *
   *  HOISTED since design note #416. It was an inline lambda inside the
   *  reducer's context object, which was fine while the float was the only
   *  thing that needed it; the home-station prompt needs the SAME mapping to
   *  decide which corporations owe a token and to name the hex it is bound
   *  for. Two copies of "where is H12" is two answers waiting to disagree,
   *  and the disagreement would be a modal pointing at the wrong hex. */
  const homeHexToAxial = useCallback((label: string): readonly [number, number] | null => {
    const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
    return hex ? ([hex.q, hex.r] as const) : null;
  }, []);

  /* DECLARED HERE, not up with `mustBuyTrain`, and the placement is not
     cosmetic: this memo reads `sandboxMarketPrices` to value the
     president's holdings, and `const` bindings are not hoisted. `useMemo`
     runs its callback and evaluates its dependency array during the render
     pass, so declaring it above that table would throw a ReferenceError on
     first paint rather than fail later. */
  /* ===================================================================
   *  DESIGN NOTE 332: THE EMERGENCY, DETECTED
   * ===================================================================
   *
   * `mustBuyTrain` says the corporation is OBLIGED to buy. This says it
   * cannot AFFORD to, which is the harder half and the one that costs the
   * president their own money -- see `EmergencyTrainPurchaseModal.tsx`
   * design note #0.
   *
   * THE PRICE IS THE DEPOT'S CHEAPEST PURCHASABLE TIER, not the cheapest
   * printed train. 1830's depot sells cheapest-FIRST, so once the 2s are
   * gone the 3-train is the cheapest thing money can buy there, and pricing
   * the emergency against a $80 train nobody can buy would understate the
   * shortfall by $100. `depotInventory` already models that queue.
   *
   * `null` -- rather than a plan with a zero shortfall -- whenever there is
   * no emergency, so the modal's own mount condition is one identity check
   * and cannot disagree with this derivation about whether one exists. */
  /* ==================================================================
   *  DESIGN NOTE 433: NO ROUTE, NO OBLIGATION
   * ==================================================================
   *
   * REPORTED: a floated company with no valid routes is being forced to buy
   * a train -- End Turn is blocked and there is no way out of the turn.
   *
   * Design note #293 built this gate and stated the rule as "a corporation
   * that owns no train MUST buy one ... There is no branch of that rule
   * where the turn simply ends." That is half of 1830's rule and the half
   * that produces a deadlock.
   *
   * The full rule is conditional on being able to USE the train: a
   * corporation is obliged to buy only if it has no trains AND has a route
   * it could actually run. A company whose token sits on a city no track
   * reaches has nothing to run, so it is not obliged, and 1830 lets its
   * turn end. Forcing the purchase there is worse than a rules error --
   * design note #293 deliberately keeps the button disabled even on an
   * empty treasury, on the reasoning that the president must pay. So a
   * corporation with no route and a poor president had End Turn disabled,
   * the emergency modal demanding money for a train that could go nowhere,
   * and no third control on the screen. That is a stuck game.
   *
   * THE PROBE ASKS A HYPOTHETICAL, which is what makes it different from
   * `maxRouteRevenue` (design note #414) a few hundred lines below. That
   * one measures what the trains a corporation OWNS can earn, and returns
   * `null` when it owns none -- which is exactly the situation here, so it
   * cannot answer this question. This asks instead: if this corporation
   * bought the cheapest train available, could it run anything? A 2-train
   * (two revenue centres) is the right hypothetical because it is the
   * smallest thing the depot sells, so a "no" from it is a "no" for every
   * train -- a bigger train reaches strictly more.
   *
   * `assignRouteSet` is the same search Auto Route and the auto-withhold use.
   * A third opinion about what is runnable is how "the board says I can run
   * and the button says I cannot" happens.
   *
   * IGNORANCE PERMITS, consistent with design note #293b above. No tokens on
   * the board, no map yet, or a corporation the state does not carry all
   * resolve to "no obligation" and leave End Turn live -- the contract
   * refuses an illegal exit on its own, and a wrongly-enabled button costs a
   * rejected message while a wrongly-disabled one costs the game. */
  const couldRunARouteIfItHadATrain = useMemo(() => {
    const corporation = gameState?.public_companies.find(
      (entry) => entry.company_id === actingProtocolId,
    );
    const startHexes = corporation?.station_token_hexes ?? [];
    if (startHexes.length === 0) return false;

    const result = assignRouteSet({
      mapGrid,
      era: ERA_FOR_PHASE_TINT[currentPhase?.tint ?? "yellow"],
      startHexes,
      // The cheapest train in the depot -- see the note above on why the
      // smallest hypothetical is the correct one.
      trains: [{ trainIndex: 0, maxRevenueCentres: 2 }],
    });
    return result.totalRevenue > 0;
  }, [gameState, actingProtocolId, mapGrid, currentPhase]);

  /** Design note #433: BOTH conditions. Owning no train is necessary and was
   *  being treated as sufficient. */
  const mustBuyTrain = trainlessAndReported && couldRunARouteIfItHadATrain;

  const emergencyPurchasePlan = useMemo(() => {
    /* ==============================================================
     *  DESIGN NOTE 358: THREE CONDITIONS, NOT ONE
     * ==============================================================
     *
     * REPORTED: the modal appears immediately in the Zero State sandbox.
     *
     * It did, and the reason is that `mustBuyTrain` alone is a much weaker
     * claim than it reads as. It answers "does this corporation own zero
     * trains", which in a zero state is true of ALL EIGHT of them before
     * anybody has done anything -- so the first thing a new player saw was
     * a blocking emergency for a company that had not taken a turn.
     *
     * The obligation only exists at the moment it is due. All three:
     *
     *   THE ROUND    an Operating Round. Nothing buys trains in a Stock
     *                Round or the auction.
     *   THE STEP     `Hardware`, the Buy Trains sub-phase. A corporation
     *                mid-track-lay is not yet obliged to do anything about
     *                its empty roster.
     *   THE MONEY    treasury below the cheapest depot train, which is the
     *                condition that makes it an EMERGENCY rather than an
     *                ordinary purchase.
     *
     * The zero state fails the first two, which is why the report describes
     * it appearing "immediately". */
    if (!mustBuyTrain || !gameState) return null;
    if (gameState.current_round_type !== "OperatingRound") return null;
    if (orSubPhase !== "Hardware") return null;
    const corporation = gameState.public_companies.find(
      (entry) => entry.company_id === actingProtocolId,
    );
    if (!corporation) return null;

    const cheapest = depotInventory(gameState).find(
      (row) => !row.rusted && (row.remaining === null || row.remaining > 0),
    );
    if (!cheapest) return null;

    const treasury = Number(corporation.treasury) || 0;
    // No shortfall, no emergency: the ordinary Buy Trains panel handles it.
    if (treasury >= cheapest.cost) return null;

    return buildEmergencyPurchasePlan({
      state: gameState,
      corporation,
      trainModel: cheapest.tier,
      trainCost: cheapest.cost,
      priceForCompany: (companyId) => (sandbox ? (sandboxMarketPrices[companyId] ?? null) : null),
      labelForAddress: (address) => sandboxPlayerLabel(address) ?? truncateAddress(address),
    });
  }, [mustBuyTrain, gameState, orSubPhase, actingProtocolId, sandbox, sandboxMarketPrices]);

  /* Design note #3 in the modal: there is no dismissal any more. The plan
     IS the mount condition -- `null` when there is no emergency, and
     present for exactly as long as one is unresolved. The
     `dismissedEmergencyFor` state that stood here let a player close the
     modal and carry on, which is the bug requirement 1 reports. */
  const emergencyModalPlan = emergencyPurchasePlan;

  /* ===================================================================
   *  DESIGN NOTE 359: THE TWO ENDINGS
   * ===================================================================
   *
   * 1830 stops when the bank breaks or when a president cannot fund a
   * mandatory train. Both are derived rather than stored, and neither is a
   * message the contract sends -- `GetGameState` reports `is_active`, but
   * the sandbox has no path that flips it, and on a live chain the poll
   * would deliver the ending anyway.
   *
   * BANKRUPTCY IS READ OFF THE EMERGENCY PLAN, not computed a second time.
   * `endgame.ts` already decides it, the modal already renders it, and a
   * parallel derivation here could disagree with the modal about whether
   * the game had ended -- which would show a Game Over behind a still-live
   * emergency, or the reverse.
   *
   * ORDER MATTERS: bankruptcy wins. If a president is bankrupt AND the bank
   * has emptied in the same tick, the bankruptcy is the more specific
   * story and the one with a named player in it. */
  const gameEndReason = useMemo<GameEndReason | null>(() => {
    if (emergencyPurchasePlan?.bankrupt) return "bankruptcy";
    if (sandbox && bankIsBroken(gameState)) return "bank-broken";
    return null;
  }, [emergencyPurchasePlan, sandbox, gameState]);

  const bankruptLabel = emergencyPurchasePlan?.bankrupt
    ? emergencyPurchasePlan.presidentLabel
    : null;

  /** Design note #3 in `endgame.ts`: cash, shares at market, privates at
   *  face. Computed only once the game has actually ended -- ranking four
   *  players on every render of a live game is work nobody is looking at. */
  const finalStandings = useMemo(() => {
    if (!gameEndReason || !gameState) return [];
    return rankPlayers({
      state: gameState,
      priceForCompany: (companyId) => (sandbox ? (sandboxMarketPrices[companyId] ?? null) : null),
      labelForAddress: (address) => sandboxPlayerLabel(address) ?? truncateAddress(address),
      bankruptAddress: emergencyPurchasePlan?.bankrupt
        ? emergencyPurchasePlan.presidentAddress
        : null,
      totalAnte: PLACEHOLDER_TOTAL_ANTE,
    });
  }, [gameEndReason, gameState, sandbox, sandboxMarketPrices, emergencyPurchasePlan]);

  const waterfallState = sandboxWaterfall ?? liveWaterfallState;

  // Resets the Contextual Top Action Bar's OR sub-phase back to "Track"
  // whenever a NEW corporation's turn starts (`active_corporation_index`
  // changes) or the room leaves an Operating Round entirely -- see design
  // note #10/item 2. Deliberately keyed on these two live poll fields, not
  // on every poll tick, so it fires exactly once per actual turn change.
  /* ===================================================================
   *  DESIGN NOTE 175: THE SANDBOX OPENS ON TRACK
   * ===================================================================
   *
   * THIS, not an address mismatch, is what was locking the green check.
   * Measured rather than inferred: in the sandbox fixture the acting
   * corporation is PRR, its president is Alice, auto-follow puts the hotseat
   * on Alice, and `president === viewerAddress` evaluates TRUE. Every
   * identity check passes. The gate that failed was the sub-phase one --
   * `initialOrSubPhase` returns `BuyPrivate` from Phase 3 on (mirroring
   * `or_phase::initial_sub_phase`), the fixture runs in the Green era, and
   * confirming a tile lay requires `Track`.
   *
   * That is CORRECT for a live room and stays correct there: the contract
   * persists its own cursor, opens the turn at `BuyPrivate`, and rejects a
   * lay submitted out of order. Weakening it would make the bar disagree
   * with the chain.
   *
   * The sandbox has no cursor to disagree with. It is a testing surface
   * whose whole purpose is reaching the board quickly, and opening it on a
   * step where the picker is locked -- with the remedy one unexplained
   * click away in a different control -- fails at that. Same justification
   * as the seat switcher and the legality filter before it: sandbox gets
   * the affordance precisely because there is no authority there to
   * contradict.
   *
   * A player can still walk back to `BuyPrivate` on the stepper, so nothing
   * is unreachable -- only the default changed.
   */
  /* Design note #385: and it never opens on a step that is not there.
     `initialOrSubPhase` returns `BuyPrivate` from Phase 3 on, but the strip
     now drops that step once nothing is buyable -- so seeding the cursor
     there would put the turn on a hidden step, which reads as an empty
     action panel with no way forward but Skip. `visibleSubPhases` is asked
     rather than re-deriving the condition, so the cursor and the strip
     cannot disagree about which steps exist. */
  useEffect(() => {
    const steps = visibleSubPhases(
      gameState?.current_global_era,
      gameState?.private_companies,
    );
    const opening = sandbox ? "Track" : initialOrSubPhase(gameState?.current_global_era);
    setOrSubPhase(steps.includes(opening) ? opening : steps[0]);
  }, [gameState?.current_round_type, gameState?.active_corporation_index, gameState?.current_global_era, gameState?.private_companies, sandbox]);

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
      // Design note #213: jump to the surface the new round is played on.
      // The four-way branch that stood here is now one lookup shared with
      // the availability guard below, which is what stops the two from
      // disagreeing about where a Stock Round lands.
      setActiveMainTab(surfaceTabFor(currentRoundType));

      /* ===============================================================
       *  DESIGN NOTE 331: THE PRIVATES ARE PAID HERE, AND ONLY HERE
       * ===============================================================
       *
       * `sandboxSession.ts` design note #328 explains why the reducer
       * does not own this trigger: an Operating Round runs one TURN per
       * floated corporation, so anything hung off a turn would pay the
       * privates once per company per round.
       *
       * This branch is already the app's single "the round genuinely
       * changed" edge -- it fires on a real transition compared against
       * `prevRoundTypeRef`, not on every poll tick that reports the same
       * round. That is exactly the once-per-round guarantee the payout
       * needs, and reusing it is better than adding a second round-change
       * detector that could disagree with this one about when a round
       * started.
       *
       * SANDBOX ONLY. On a chain the contract pays the privates and the
       * balances arrive in the next `GetGameState`; crediting them locally
       * as well would double every owner's income on screen until the
       * poll corrected it. */
      if (sandbox && currentRoundType === "OperatingRound") {
        payPrivateRevenueRef.current?.();
      }
    }
  }, [gameState?.current_round_type, sandbox]);

  // Design note #28: the tab set changes shape by phase, so the active tab
  // can cease to exist under the player -- sitting on "Auction" when the
  // auction ends leaves `activeMainTab` pointing at a tab no longer in the
  // bar, which renders nothing at all. Separate from the auto-navigation
  // effect above on purpose: that one fires only on genuine TRANSITIONS and
  // deliberately never overrides a manual click, whereas this is a
  // correctness guard that must run whenever the pairing is invalid.
  useEffect(() => {
    const roundType = gameState?.current_round_type ?? null;
    if (!isTabAvailable(activeMainTab, roundType)) {
      // Design note #213: the ROUND'S OWN SURFACE, not a hardcoded `"map"`.
      // This effect and the transition effect above both run in the commit
      // where the round type changes, and this one still sees the tab the
      // player was on rather than the one just chosen -- so a constant here
      // silently overrode that choice. Asking the same function means the
      // redirect agrees with the transition instead of undoing it.
      setActiveMainTab(surfaceTabFor(roundType));
    }
  }, [activeMainTab, gameState?.current_round_type]);

  // Design note #34: `vgpBalance` and `derivedVgpBalanceNote` are DELETED.
  // Both existed only to feed the top bar's Cash readout, which is gone --
  // in-game cash lives in the Game Ledger and the Player Index now. The
  // The whole optimistic-note chain went with them: `vgpBalanceNote` state,
  // `runGameplayAction`'s third parameter, and the two notes BuyStock and
  // SellStock passed into it. Those two were the only writers, and their
  // only reader was the readout just deleted -- a write path to a value
  // nothing displays is how a "harmless" leftover becomes a puzzle later.

  /* `activePlayerAddress` went with design note #165's tray. It answered
     "whose privates can be sold right now", which only made sense while the
     tray was scoped to the acting player; the proposal sheet shops across
     every player's holdings, so the question no longer has a caller. */

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
  // The phase-dependent logic this used to spell out inline now lives in
  // `actingSeatIndex` (`utils/gameState.ts`), because the sandbox's
  // Auto-Follow needs the SAME answer to a slightly different question --
  // "which seat may act" rather than "may I act". Two hand-written copies of
  // the Operating-Round-means-the-president rule would be two things to keep
  // in step, and the failure would be silent: the toolbar would follow one
  // player while the controls enabled for another.
  //
  // `null` means no seat may act at all -- an Operating Round with an empty
  // queue, or a floated-but-presidentless corporation. Nobody's turn, rather
  // than everybody's, which is what makes the fallback to the Stock Round
  // pointer deliberately absent.
  const isMyTurn = useMemo(() => {
    if (!viewerAddress || !gameState) return false;
    const seat = actingSeatIndex(gameState);
    return seat !== null && gameState.player_addresses[seat] === viewerAddress;
  }, [viewerAddress, gameState]);

  useDocumentTitleFlash(isMyTurn);

  /** Design note #300: the acting seat's personal cash. `null` when there
   *  is no seat on turn or the chain does not report it -- a missing wallet
   *  must not render as $0, which is a real and very different state.
   *
   *  Design note #317: during the Waterfall Auction this is AVAILABLE cash,
   *  not the total. The badge sits next to Pass and Undo on the one screen
   *  where the difference decides every action, and a player reading $600
   *  off the bar while $400 of it stands on a bid would be reading the one
   *  figure they cannot spend. Outside the auction there is no escrow, so
   *  `availableCash` returns the total and the badge is unchanged. */
  const activeSeatCash = useMemo(() => {
    if (!gameState) return null;
    const seat = actingSeatIndex(gameState);
    if (seat === null) return null;
    const address = gameState.player_addresses[seat];
    if (!address) return null;
    return availableCash(gameState, waterfallState, address);
  }, [gameState, waterfallState]);

  /* Design note #342: every seat's spendable cash, in seating order.
     Only during the AUCTION -- a Stock Round bar showing four balances
     would be four numbers none of which gates the acting player's buy, and
     an Operating Round spends a treasury rather than a wallet. The empty
     array is what makes the bar fall back to the single acting badge. */
  /* ==================================================================
   *  DESIGN NOTE 406: THE ROSTER IS NOT ONLY THE AUCTION'S
   * ==================================================================
   *
   * REPORTED: add a player roster to the Stock Round action panel, matching
   * the auction's style, with the active player in green.
   *
   * The roster already existed and already highlighted the acting seat in
   * green -- it was simply refused to every round but one by the guard on
   * this line. Nothing about the pills is auction-specific: they show who is
   * at the table, whose turn it is, and what each seat can spend, all of
   * which a Stock Round player wants at least as much.
   *
   * ESCROW IS AUCTION-ONLY and stays correct by construction: `escrowedBids`
   * reads the waterfall document, which is absent outside the auction, so it
   * returns zero and `rosterPillEscrow` renders nothing. The pill simply has
   * one fewer figure in it during a Stock Round, which is the truth.
   *
   * OPERATING ROUNDS ARE STILL EXCLUDED. An OR turn belongs to a
   * CORPORATION, not a seat -- the bar already names the acting corporation
   * and its president -- so a seat roster there would be answering a
   * question nobody is asking, and `actingSeatIndex` has no meaningful
   * answer to give. */
  const playerRoster = useMemo(() => {
    if (!gameState) return [];
    if (
      gameState.current_round_type !== "WaterfallAuction" &&
      gameState.current_round_type !== "StockRound"
    ) {
      return [];
    }
    const seat = actingSeatIndex(gameState);
    const active = seat === null ? null : gameState.player_addresses[seat];
    return gameState.player_addresses.map((address) => ({
      address,
      label: sandboxPlayerLabel(address) ?? truncateAddress(address),
      available: availableCash(gameState, waterfallState, address) ?? 0,
      escrowed: escrowedBids(waterfallState, address),
      isActive: address === active,
    }));
  }, [gameState, waterfallState]);

  /** What the acting seat has locked in standing bids, for the badge's
   *  tooltip. Zero outside the auction. */
  const activeSeatEscrow = useMemo(() => {
    if (!gameState) return 0;
    const seat = actingSeatIndex(gameState);
    if (seat === null) return 0;
    const address = gameState.player_addresses[seat];
    return address ? escrowedBids(waterfallState, address) : 0;
  }, [gameState, waterfallState]);

  /** Whose turn it is, as a name. `null` outside a seat-driven round or
   *  when the room has not started -- the header then shows nothing rather
   *  than an empty label. */
  const activeSeatLabel = useMemo(() => {
    if (!gameState) return null;
    const seat = actingSeatIndex(gameState);
    if (seat === null) return null;
    const address = gameState.player_addresses[seat];
    if (!address) return null;
    return sandboxPlayerLabel(address) ?? truncateAddress(address);
  }, [gameState]);

  /* Design note #398, the "and for all players" half. In hotseat the seats
     share one browser, so a par half-chosen by the outgoing player would
     still be highlighted for the incoming one -- who would then buy a
     president's certificate at a price they never picked. Cleared on the
     seat change, the same trigger `StockRoundPanel` uses to drop its active
     card. */
  useEffect(() => {
    setSrParValues({});
  }, [activeSeatLabel]);

  // In-Place Accordion Ticker / Inline Control Strip state -- design note
  // #18, converted from a modal to an in-place accordion by design note
  // #20. `chatMessages` was previously owned entirely inside
  // `Chatbox.tsx`; moved up here so it can be merged with `actionLog` into
  // one chronologically sorted timeline (`mergeFeedItems`).
  //
  // Design note #22 (Step 4): the LOCAL `useState<ChatMessage[]>` that used
  // to live on this line is replaced by a live Firestore subscription. Note
  // what did NOT have to change as a result -- `feedItems`, the filter, the
  // unread count, `TopTicker` and `InlineQuickChat` are all untouched,
  // because every one of them was already reading from `mergeFeedItems`
  // rather than owning chat state. That is the payoff of the hoist design
  // note #18 performed: swapping chat from a local array to a multiplayer
  // transport is a one-line change at exactly one call site.
  //
  // Keyed on `roomId` (Firestore), NOT `gameId` (contract) -- chat is
  // off-chain and belongs to the off-chain room, which is what lets the
  // staging-room transcript in `Lobby.tsx` continue uninterrupted into the
  // live game instead of resetting at launch.
  const {
    messages: chatMessages,
    sendMessage: sendChatMessage,
    error: chatError,
    // Design note #24: `null` in sandbox. `SANDBOX_ROOM_ID` names no real
    // Firestore document, and subscribing to it would CREATE one the first
    // time anyone typed -- littering the room collection with junk rooms
    // from what is supposed to be a local, chain-free scratchpad.
  } = useFirestoreChat(sandbox ? null : roomId, wallet.address, displayName);
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

  // Design note #22: pushes to `games/{roomId}/chat` instead of appending to
  // a local array. The draft is cleared optimistically because the write is
  // ALSO optimistic -- Firestore applies it to the local snapshot before the
  // server confirms, so the message is on screen immediately and the round
  // trip finishes in the background (see `ChatBox.tsx` design note #2 for
  // the timestamp handling that makes that ordering stable).
  const handleSendChatMessage = useCallback(() => {
    const text = chatDraft.trim();
    if (!text) return;
    setChatDraft("");
    void sendChatMessage(text);
  }, [chatDraft, sendChatMessage]);

  /* REMOVED with design note #165: `sellablePrivates`,
     `selectedPrivateId`, `privatePriceVgp`, their seeding effect, and
     `handleSelectPrivate`.

     All five existed to drive the inline tray's dropdown-and-slider. The
     proposal sheet owns its own selection and price, and reads the whole
     `private_companies` list directly so it can show privates owned by ANY
     player -- which is the point. `sellablePrivates` was scoped to
     `activePlayerAddress`, i.e. to what the acting player could sell
     THEMSELVES, which is the wrong set for a corporation shopping among
     everyone's holdings and is why the old tray could not express the
     trade it was named after. */


  /* ==================================================================
   *  DESIGN NOTE 343 (source): THE ROUND, AS A SHORT TAG
   * ==================================================================
   *
   * This memo has existed, correct and completely unused, since it was
   * written -- it is the `roundLabel is assigned a value but never used`
   * warning that has been standing in this file's lint output. It computes
   * exactly the round context the Activity Log now stamps on every entry,
   * so it is wired rather than deleted.
   *
   * Formats follow the brief: `Auction`, `SR1`, `OR 1.1`. The auction case
   * shortened from "Waterfall Auction" because this is a prefix in a
   * gutter, not a heading -- "[Waterfall Auction]" is wider than most of
   * the lines it would sit beside.
   */
  const roundLabel = useMemo(() => {
    if (!gameState) return null;
    // Pre-Game Waterfall Auction (`waterfall.rs`): every room now
    // genesis-starts here, before `macro_round_number`'s "SR1"/"OR1.1"
    // numbering is meaningful at all.
    if (gameState.current_round_type === "WaterfallAuction") return "Auction";
    if (gameState.current_round_type === "StockRound") {
      return `SR${gameState.macro_round_number}`;
    }
    const suffix = gameState.sub_round_index > 0 ? `.${gameState.sub_round_index}` : "";
    return `OR ${gameState.macro_round_number}${suffix}`;
  }, [gameState]);

  /* Read through a ref by the log writers, which are declared above this
     memo -- the same ordering workaround `logInfoRef` uses. A ref also
     means the stamp is taken at WRITE time rather than closed over at
     callback-construction time, which is what design note #343 requires:
     an entry written during the auction must keep `[Auction]` even though
     the callback that wrote it was built rounds earlier. */
  const roundLabelRef = useRef<string | null>(null);
  useEffect(() => {
    roundLabelRef.current = roundLabel;
  }, [roundLabel]);

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

  /** The board's DOM node, for anchoring the radial ring to the canvas
   *  rather than to the viewport. A callback ref rather than `useRef` so a
   *  re-mount re-measures instead of holding a stale node. */
  const [boardEl, setBoardEl] = useState<HTMLDivElement | null>(null);

  /** Design note #199: the ONE condition under which the tile selector
   *  exists at all. Track is this UI's name for the contract's Lay Track
   *  sub-phase (`OPERATING_SUB_PHASE_LABELS.Track` renders as "Lay Track").
   *
   *  Spectators are excluded here as well as by `runGameplayAction`'s own
   *  gate, for the same reason the action bar is hidden from them: a control
   *  they can open and never use is noise, not courtesy. */
  /* ==================================================================
   *  DESIGN NOTE 437: LOOKING IS NOT ACTING
   * ==================================================================
   *
   * REPORTED: non-active players cannot select hexes to view the tile
   * selector during an Operating Round.
   *
   * One flag was answering two questions. `tileSelectorArmed` decided both
   * "may this person OPEN the picker" and, through `layTrackFocus` and the
   * click interceptor, "is this the Lay Track step" -- so narrowing it to
   * the acting player's Track step, which is correct for the second, also
   * closed the picker to everyone else for the whole round.
   *
   * Design note #163 had already drawn this line once and drawn it in the
   * right place: "`canLayTileNow` is deliberately NOT the condition. That
   * value also refuses when it is not your turn, and a player should still
   * be able to browse upgrades on somebody else's Track step." The
   * principle was sound and the gate it protected was still the wrong one,
   * because `tileSelectorArmed` itself carried `!spectator` and the
   * sub-phase.
   *
   * So the flag splits in two, and each half answers its own question:
   *
   *   INSPECTING is available to anyone, in any sub-phase of an Operating
   *   Round, spectators included. Reading the board is not a move, and a
   *   player deciding what to do on their turn wants to study the upgrades
   *   available at a hex before it arrives.
   *
   *   ACTING keeps every restriction it had. `canLayTileNow` (design note
   *   #163) still gates the ring's confirm button, and it still refuses a
   *   spectator, a wrong sub-phase and a wrong turn -- so a browsing player
   *   sees a disabled Lay Track button carrying the reason, not a live one.
   *
   * THE COST IS REAL AND WORTH NAMING. The original note's third argument
   * for the narrow gate was that "gating only here would leave every stray
   * click costing a query round-trip" -- `GetLegalTilePlacements` fires on
   * a resolved hex click. Widening the inspector widens that. It is
   * accepted because the query is read-only, cheap, and already fires on
   * every Track-step click; a player browsing is doing the thing the query
   * exists to answer. The `sandbox` and `spectator` exclusions on the
   * `queryClient` prop are unchanged, so neither path adds chain traffic. */
  const tileInspectorArmed =
    (gameState?.current_round_type ?? null) === "OperatingRound";

  /** The Lay Track step proper -- what the veil and the legal-placement
   *  reach are about. Distinct from `tileInspectorArmed` above: this is the
   *  step, that is permission to look at it. */
  const tileLayStepActive =
    !spectator && tileInspectorArmed && orSubPhase === "Track";

  /* ==================================================================
   *  DESIGN NOTE 224: ONLY LIGHT WHAT THIS CORPORATION CAN REACH
   * ==================================================================
   *
   * The board-dimming set for the Lay Track sub-phase -- `trackReach`'s own
   * design note #0 covers what it does and does not claim.
   *
   * `undefined` OUTSIDE LAY TRACK, which is what switches the veil off
   * entirely: no dimming, no click gate, the board exactly as it was. The
   * renderer treats an absent set that way by construction (design note
   * #223 there), so there is one condition here rather than a flag pair that
   * could disagree.
   *
   * ALSO `undefined` WHEN THE REACH IS UNKNOWABLE. `layableHexes` reports
   * `unconstrained` for a corporation with no token on the board -- one that
   * has floated but not yet placed its home, or any state reached before the
   * first `GetGameState` resolves. Dimming everything then would tell the
   * player they may build nowhere, which is both wrong and
   * indistinguishable from the feature being broken. The hint is dropped and
   * the contract stays the authority, which is the safe direction to fail.
   */
  const layTrackFocus = useMemo(() => {
    // Design note #437: the STEP, not the inspector. Veiling the board
    // while a player is merely browsing would tell them they may not build
    // on hexes that are simply not their concern this second.
    if (!tileLayStepActive) return undefined;
    const corporation = gameState?.public_companies.find(
      (entry) => entry.company_id === actingProtocolId,
    );
    const reach = layableHexes({
      mapGrid,
      stationHexes: corporation?.station_token_hexes ?? [],
    });
    if (reach.unconstrained) return undefined;
    /* Design note #241: the corporation's OWN NETWORK stays lit alongside
       the legal placements. Choosing where to extend is a judgement about
       the route the extension joins, and veiling that route left the legal
       hexes lit and the reason for preferring one of them in the dark.
       Unioned here rather than inside the renderer because this is the
       layer that has both halves. */
    const visible = new Set<string>(reach.network);
    reach.hexes.forEach((key) => visible.add(key));
    // `network` is carried alongside for the rotation filter, which needs
    // the hexes that ACTUALLY CARRY TRACK -- not `visible`, which also holds
    // the empty extension candidates. A tile cannot join a bare hex.
    return {
      visible,
      highlighted: reach.hexes,
      network: reach.network,
      /* Design note #483: the reachable EDGES, carried alongside the hexes.
         The rotation filter needs both -- a hex set alone cannot say which
         side of a crossover the corporation is on, and re-deriving it there
         is what produced the reported bug. */
      ports: reach.ports,
      // Design note #252/#253: the acting corporation's colour, lifted if it
      // is too dark to read as light against the veiled board.
      glowColor: glowColorFor(stationTickerColor(actingProtocolId)),
    };
  }, [tileLayStepActive, gameState, actingProtocolId, mapGrid]);


  /* Design note #199, layer 3: a ring left open when the turn moves on. The
     sub-phase can advance without a board click -- the stepper's Advance
     button, a token placed, another player's action arriving on a poll -- so
     closing on the next click would leave the carousel floating over a board
     that has moved past it. */
  useEffect(() => {
    if (tileInspectorArmed) return;
    setRadialSelector(null);
    setPreviewTile(null);
  }, [tileInspectorArmed]);

  const handleHexClickQuery = useCallback((state: HexClickQueryState) => {
    setHexClickQuery(state);

    /* ================================================================
     *  DESIGN NOTE 199: THE TILE SELECTOR IS A LAY TRACK TOOL, FULL STOP
     * ================================================================
     *
     * Design note #163 ("Universal Planning Mode") made the ring openable in
     * every phase, on the reasoning that INSPECTING a hex is harmless and
     * only DISPATCHING needs gating. The reasoning was sound and the result
     * was not: a tool that opens on every click, in every round, and then
     * refuses at the last step is a tool that reads as broken. Worse, it
     * competes for the click during the Tokens and Routes sub-phases, where
     * the board's click means something else entirely -- the player is
     * aiming at a city to place a token and gets a tile carousel.
     *
     * The gate is now STRICT and it is applied at the point the ring opens,
     * not at the point it confirms. Three layers, all of them necessary:
     *
     *   1. HERE -- a resolved query never opens the ring outside `Track`.
     *   2. The renderer's four interceptor props (`queryClient` and friends)
     *      are withheld outside `Track`, so on a live chain the click does
     *      not even fire `GetLegalTilePlacements`. Gating only here would
     *      leave every stray click costing a query round-trip.
     *   3. `<RadialTileSelector>` is not mounted outside `Track`, so a ring
     *      already open when the sub-phase advances closes with it rather
     *      than floating over a board that has moved on.
     *
     * `canLayTileNow` is deliberately NOT the condition. That value also
     * refuses when it is not your turn, and a player should still be able to
     * browse upgrades on somebody else's Track step -- which is the half of
     * design note #163 worth keeping. The sub-phase is the whole gate. */
    if (!tileInspectorArmed) {
      setRadialSelector(null);
      setPreviewTile(null);
      return;
    }

    // Design note #162/#163: a resolved hex click OPENS THE RADIAL SELECTOR.
    //
    // Both answer shapes feed the same selector -- `"success"` carries the
    // contract's verbatim `placements`, `"offline"` the local catalog
    // mirror, and `provisional` is the only thing that distinguishes them
    // downstream. `"blocked"` and `"loading"` are not openings: the first
    // is a transient nudge with its own timer above, the second has nothing
    // to show yet.
    //
    // Design note #172: `"not-a-hex"` is a CLOSING. Clicking open water is
    // the most natural "never mind" gesture there is, and it used to do
    // nothing at all -- the renderer returned before reporting anything, so
    // an open ring just sat there. It now falls into the same `else` as
    // every other non-opening status, which closes.
    if (state.status === "success" || state.status === "offline") {
      setPreviewTile(null);
      // Converted to a board-relative offset at capture time -- the raw
      // client point is only correct until something scrolls.
      setRadialSelector({
        q: state.q,
        r: state.r,
        hexLabel: state.hexLabel,
        // Design note #171: the HEX CENTRE, not the cursor. Already in
        // canvas-CSS pixels and already through the live pan/zoom
        // transform, so the ring sits on the hex however the board is
        // scrolled, panned or zoomed.
        offsetX: state.centroidX,
        offsetY: state.centroidY,
        /* Design note #506: and the hex's radius AS DRAWN, from the same
           report and through the same transform. The ring sizes its
           candidates and its clearance against this, so both follow the
           board's zoom instead of assuming one. */
        hexRadiusPx: state.hexRadiusPx,
        provisional: state.status === "offline",
        placements: state.status === "success" ? state.response.placements : state.placements,
      });
    } else {
      setRadialSelector(null);
      setPreviewTile(null);
    }
    // `boardEl` dropped: design note #171 replaced the `getBoundingClientRect`
    // arithmetic that needed it with the centroid the renderer now reports,
    // so this closure reads nothing from the DOM at all any more.
  }, [tileInspectorArmed]);

  /* Design note #162: CLICK THE PREVIEW TO ROTATE IT.
   *
   * Rotation belongs on the tile, not in a panel: you are looking at the
   * hex to decide whether the tile fits, and every pixel of travel to a
   * separate control is travel away from the thing being judged.
   *
   * 60 degrees CLOCKWISE per click, wrapping at six -- so the gesture is
   * also its own reset, and a player who overshoots keeps clicking rather
   * than hunting for a second, opposite control.
   *
   * Only fires for a click on the hex the selector is open on. A click on
   * any OTHER hex is a new selection and falls through to the normal
   * interceptor. */

  // Design note #141: a blocked cue is a transient nudge, not a state the
  // player has to dismiss. Every other `hexClickQuery` status ends by the
  // player closing the popup (`handleCloseTilePopup`), but a blocked click
  // opens no popup, so there is no close button and nothing would ever
  // clear it -- the tooltip would sit on the board until the next click.
  //
  // Keyed on the whole state object rather than on `status`, so clicking a
  // SECOND blocked hex restarts the timer instead of inheriting the first
  // one's remaining time (which, on a fast double-click, could dismiss the
  // second message almost immediately).
  useEffect(() => {
    if (hexClickQuery?.status !== "blocked") return undefined;
    const timer = window.setTimeout(() => {
      // Clears only if nothing has replaced it in the meantime -- otherwise
      // a timer from an earlier click could wipe a live "loading" or
      // "success" state belonging to a later one.
      setHexClickQuery((current) => (current === hexClickQuery ? null : current));
    }, 2600);
    return () => window.clearTimeout(timer);
  }, [hexClickQuery]);


  // Manual Route Point UI state -- see design note #11. `routeSelectMode`
  // gates whether `<HexGridRenderer>` below is wired for route-point
  // clicking (via its plain `onHexClick`) instead of its normal
  // LayTile-popup click interceptor; `routePoints` is the resulting chain,
  // `routeFeedback` a short-lived inline message for a rejected click
  // (non-adjacent to the last point).
  // Design note #44: armed by finishing a first Operating Round as a
  // president. One-way -- `TutorialModal` handles dismissal and remembering.
  const [marketTutorialArmed, setMarketTutorialArmed] = useState(false);

  // Design note #158: the Tutorials front door's open/closed state. Separate
  // from the four `TutorialModal`s' own state, and deliberately so -- those
  // track "has this player been shown this yet", which is a different
  // question from "is the reader open right now".
  const [tutorialLibraryOpen, setTutorialLibraryOpen] = useState(false);

  // Design note #159: station-token targeting mode. Same shape as
  // `routeSelectMode` -- while it is on, the board's query-firing click
  // interceptor is disarmed and clicks route to a token handler instead.
  const [tokenTargetMode, setTokenTargetMode] = useState(false);

  /* ===================================================================
   *  DESIGN NOTE 201: A TOKEN IS CONFIRMED, NOT DROPPED
   * ===================================================================
   *
   * Clicking a city used to place the token and charge the treasury in the
   * same gesture. That is the only irreversible, money-spending board action
   * in this app with no confirmation step -- laying a tile, which costs
   * comparable money and is equally permanent, has always asked for a green
   * check first.
   *
   * The click now STAGES a placement. Nothing is dispatched, nothing is
   * charged, the sub-phase does not advance, and targeting mode stays armed
   * so clicking a different city simply re-aims. The green check is the only
   * thing that commits.
   *
   * The anchor is the hex CENTROID the renderer reports (design note #171),
   * not the cursor, so the ring sits on the hex however the board is
   * scrolled, panned or zoomed -- the same value the tile selector stores
   * for the same reason.
   */
  const [pendingToken, setPendingToken] = useState<{
    q: number;
    r: number;
    hexLabel: string;
    /** Design note #453: which city on the hex, or `null` when the geometry
     *  cannot say. Travels to `PlaceStationToken.city_index`. */
    cityIndex: number | null;
    /* ==================================================================
     *  DESIGN NOTE 454: THE FREE PLACEMENTS CONFIRM TOO
     * ==================================================================
     *
     * REPORTED: clicking a hex instantly places the token without
     * confirmation.
     *
     * The ORDINARY Tokens step has confirmed since design note #201 --
     * `RadialTokenConfirm` is the check/X ring the tile selector's confirm
     * is modelled on. What placed instantly were the two FREE placements
     * added later: the home station at float (design note #440) and the
     * D&H's F16 token (#444). Both wrote straight to state on the board
     * click, so the newest flows were the ones missing the oldest
     * safeguard.
     *
     * They route through this staging state now, so every station placement
     * in the app answers the same ring. `kind` is what the confirmation
     * then dispatches -- a paid `PlaceStationToken`, or a free write that
     * must NOT go through that message because it charges the escalating
     * token price (design note #239). */
    kind: "paid" | "free";
    offsetX: number;
    offsetY: number;
  } | null>(null);

  /* ==================================================================
   *  DESIGN NOTE 240: THE SAME VEIL, FOR TOKENS
   * ==================================================================
   *
   * Design note #223 built the board-dimming machinery for the Lay Track
   * step: light what the corporation may act on, veil the rest, refuse
   * clicks outside the set. Station placement has exactly the same shape --
   * a small set of legal targets scattered across a hundred hexes -- and had
   * none of it, so a player armed the token cursor and then hunted for a
   * city their network reached by eye.
   *
   * Reusing the veil rather than adding a second highlight mechanism means
   * the two steps behave identically, and the refusal a click gets is the
   * same refusal in both. The SET differs, and that is the whole difference:
   * track may be laid on hexes the network reaches OR touches, while a token
   * needs a city with a free, unreserved slot ON the network.
   *
   * ONLY WHILE TARGETING IS ARMED. The veil is a strong visual statement and
   * it should appear when the player has asked to place a token, not for the
   * whole Tokens step -- during which they may simply be reading the board. */
  const tokenTargetFocus = useMemo(() => {
    if (!tokenTargetMode) return undefined;
    if (!activeStationCompany) return undefined;
    const highlighted = placeableStationHexes({
      mapGrid,
      company: activeStationCompany,
      allCompanies: gameState?.public_companies ?? [],
      boardHexes: STATIC_BOARD_HEXES.map((hex) => [hex.q, hex.r] as const),
    });
    // Design note #241: same three tiers as the tile lay. A token placement
    // is judged against the network it joins, so that network stays lit.
    const visible = new Set<string>(
      reachableNetwork(mapGrid, activeStationCompany.station_token_hexes),
    );
    highlighted.forEach((key) => visible.add(key));
    return {
      visible,
      highlighted,
      /* ==============================================================
       *  DESIGN NOTE 514: THE RING WORE B&O'S BLUE
       * ==============================================================
       *
       * REPORTED: the placement preview renders as a blue B&O token
       * whatever corporation is acting.
       *
       * `actingProtocolId` is derived from the operating queue and falls
       * back to `MOCK_LAY_TILE_PROTOCOL_ID` when that queue is empty --
       * and that constant is `4`, which its own comment names as B&O.
       * Design note #433 introduced the fallback so nothing would render
       * `undefined` before an Operating Round had opened, which is a real
       * concern and the wrong answer HERE: a station placement always has
       * a corporation, because `activeStationCompany` is the company whose
       * tokens are being placed. It is in scope, it is exact, and it needs
       * no fallback at all.
       *
       * Reading the queue for this was asking a question about turn ORDER
       * to answer a question about IDENTITY. The two agree during an
       * ordinary Operating Round turn, which is why the wrong colour only
       * appeared when they came apart -- a home-station placement raised
       * before the queue exists being the case reported. */
      glowColor: glowColorFor(stationTickerColor(activeStationCompany.company_id)),
    };
  }, [tokenTargetMode, activeStationCompany, gameState, mapGrid]);


  /* ===================================================================
   *  DESIGN NOTE 166: THE PRIVATE COMPANY TRADE, AND WHO ACTUALLY AGREES
   * ===================================================================
   *
   * Two pieces of client-side state: the proposal sheet's open flag, and
   * the live proposal itself. Both are LOCAL -- see
   * `PrivateTradePanel.tsx` design note #0 for why the consent half cannot
   * be anything else today. `ExecuteMsg::BuyPrivateCompany` is single-party;
   * the contract never asks the seller.
   *
   * The consequence for this file is narrow and worth stating: `proposal`
   * is not synchronised to anything. In a live room the seller's client
   * will never see it, which is why the prompt tells the proposer that
   * accepting buys the private outright rather than pretending a
   * counterparty agreed.
   */
  const [privateTradeOpen, setPrivateTradeOpen] = useState(false);
  const [privateProposal, setPrivateProposal] = useState<PrivateTradeProposal | null>(null);

  /* ===================================================================
   *  DESIGN NOTE 205: TWO CONSENT FLOWS, ONE SHAPE, DIFFERENT BACKENDS
   * ===================================================================
   *
   * A train trade and a private company purchase are the same interaction
   * from the player's side -- name a price, the counterparty answers -- and
   * the app now presents them identically (see `TrainPurchasePanel`'s
   * `TrainTradePrompt` and `PrivateTradePanel`'s `PrivateTradePrompt`, kept
   * deliberately alike). What differs is what the chain can carry, and the
   * difference is worth stating because it decides where this state lives:
   *
   *   TRAINS -- the contract has the full flow.
   *   `BuyTrainFromCorporation` settles instantly when one player presides
   *   over both corporations and otherwise RECORDS an offer, which
   *   `AcceptTrainOffer`/`RejectTrainOffer`/`RescindTrainOffer` answer and
   *   `GetTrainOffers` publishes. Online, this file dispatches and the
   *   seller's own client sees the offer arrive. Nothing local is needed.
   *
   *   PRIVATES -- the contract has half of it. `BuyPrivateCompany` is
   *   single-party: it reads `private.owner` and never asks them. See
   *   `PrivateTradePanel`'s design note #0.
   *
   * `sandboxTrainProposal` therefore exists for exactly ONE deployment: the
   * offline sandbox, which has no chain to record an offer in and no second
   * client to show it to. It is the local stand-in for the offer register,
   * and it is scoped to the sandbox rather than shared with the live path so
   * that a live room can never end up answering a proposal the chain does
   * not know about.
   */
  const [sandboxTrainProposal, setSandboxTrainProposal] =
    useState<TrainTradeProposal | null>(null);

  /* ===================================================================
   *  DESIGN NOTE 163: UNIVERSAL PLANNING MODE
   * ===================================================================
   *
   * Opening the tile selector used to require being the acting president in
   * the Track sub-phase, because opening it and laying from it were the
   * same gesture. That made the board unreadable exactly when a player most
   * needs to read it: on somebody else's turn, or during a Stock Round,
   * while deciding what a corporation will be able to build next round.
   *
   * The two are now separate. INSPECTING is always allowed -- click any hex,
   * see its legal upgrades, preview one, rotate it, judge the fit.
   * DISPATCHING is gated, and only the green check is affected.
   *
   * Nothing about this loosens a rule. A preview is client-side state that
   * touches no message; `canLayTileNow` guards the one place a transaction
   * is produced, and the contract independently rejects an out-of-turn lay
   * regardless of what this UI allows.
   */
  const [radialSelector, setRadialSelector] = useState<{
    q: number;
    r: number;
    hexLabel: string;
    /** Offset of the click INSIDE the board element. Board-relative, so a
     *  page scroll cannot detach the ring from its hex. */
    offsetX: number;
    offsetY: number;
    /** Design note #506: the hex's centre-to-corner radius as drawn. */
    hexRadiusPx: number;
    /** These candidates came from the local catalog, not from a chain. */
    provisional: boolean;
    /** Verbatim `GetLegalTilePlacements`, when a chain answered. */
    placements: readonly LegalTilePlacement[];
  } | null>(null);
  const [routeSelectMode, setRouteSelectMode] = useState(false);
  /* ==================================================================
   *  DESIGN NOTE 275: ONE ROUTE PER TRAIN, KEYED BY TRAIN
   * ==================================================================
   *
   * REPORTED: the router runs a single train even when the corporation owns
   * three.
   *
   * `routePoints` was one array, so the app could hold exactly one route at
   * a time -- which is not what a 1830 corporation does. It runs every
   * train it owns in one turn, each on its own route, and the dividend is
   * the sum.
   *
   * KEYED BY INDEX INTO `owned_trains`, not by model. That is the whole
   * subtlety: a corporation with three 3-trains has three trains, and
   * "the 3-train's route" does not identify any of them. `runnableTrains`
   * had deduplicated the roster on the reasoning that "two 3-trains are one
   * CHOICE" -- correct while the question was which train to validate ONE
   * route against, wrong the moment the question became which train this
   * route belongs to.
   *
   * A `Record` keyed by that index rather than an array parallel to the
   * roster: the roster changes under this (a train rusts, one is bought
   * mid-turn) and a parallel array would silently reassign every route to
   * the wrong train when it did. Stale keys are simply ignored when the
   * drafts are read back. */
  const [routeDrafts, setRouteDrafts] = useState<Readonly<Record<number, RoutePoint[]>>>({});
  const [activeTrainIndex, setActiveTrainIndex] = useState<number>(0);
  const [routeFeedback, setRouteFeedback] = useState<string | null>(null);
  /* ==================================================================
   *  DESIGN NOTE 278: DID THIS CORPORATION ACTUALLY RUN THIS TURN?
   * ==================================================================
   *
   * The Dividends rule turns on whether revenue was EARNED THIS TURN, and
   * `last_route_revenue` cannot answer that on its own. Its own doc comment
   * is explicit: it reads as "what it earned last time", written on every
   * run and zeroed only by a run that found no route. A corporation that
   * banked $180 in OR1 and then skips Routes entirely in OR2 still reports
   * $180 -- so testing the field alone would force a Pay/Withhold choice on
   * a company that has not run a train this round, which is the opposite of
   * the rule and would dispatch a declaration with nothing behind it.
   *
   * So the turn's own history is observed: `true` once routes are declared,
   * `false` once the Routes step is skipped, and the whole record is
   * discarded when the acting corporation changes.
   *
   * `null` MEANS UNKNOWN, AND UNKNOWN ENFORCES. A page reload mid-turn
   * leaves no observation, and the two possible mistakes are not equal --
   * wrongly hiding Skip strands a player on a step, wrongly showing it
   * destroys money they have already earned. Unknown therefore falls back
   * to the field, which is the conservative side of the rule this note
   * exists to enforce. */
  /* ==================================================================
   *  DESIGN NOTE 522 (App side): THE ROOM, AND ITS CURSOR
   * ==================================================================
   *
   * Four pieces of state, and three of them are refs for the same reason:
   * `runGameplayAction` reads them, and that callback is in the dependency
   * array of the two effects that DISPATCH on the player's behalf (design
   * note #439's auto-skip and forced withhold). Rebuilding it on every
   * applied action would re-arm those effects mid-replay, which is a render
   * becoming a transaction -- and during a replay, a transaction becoming a
   * second log entry.
   *
   * `appliedIndexRef` is how far this browser has replayed. It is the
   * cursor the listener takes its tail from AND the index the next append
   * claims, which is what keeps a client's own writes in sequence with what
   * it has already applied. */
  const [sandboxRoomCode, setSandboxRoomCode] = useState<string | null>(null);
  const [sandboxRoomError, setSandboxRoomError] = useState<string | null>(null);
  const [sandboxRoomBusy, setSandboxRoomBusy] = useState(false);
  const [sandboxAppliedCount, setSandboxAppliedCount] = useState(0);
  const sandboxRoomRef = useRef<string | null>(null);
  const appliedIndexRef = useRef(0);
  const sandboxSeatRef = useRef<string>("");
  useEffect(() => {
    sandboxRoomRef.current = sandboxRoomCode;
  }, [sandboxRoomCode]);
  /* Who the log records as having acted. A LABEL, not an identity -- the
     sandbox has no authentication and this is for the readout, not for
     permission. */
  useEffect(() => {
    sandboxSeatRef.current = sandboxPlayerLabel(viewerAddress ?? "") ?? "sandbox";
  }, [viewerAddress]);

  const [routesRunThisTurn, setRoutesRunThisTurn] = useState<{
    protocolId: number;
    ran: boolean;
  } | null>(null);
  useEffect(() => {
    setRoutesRunThisTurn(null);
  }, [actingProtocolId]);

  /* Design note #492 in `utils/dividendStep.ts`: what this corporation
     actually committed at the Run Routes step, summed across every train it
     dispatched. `last_route_revenue` cannot hold it -- `RunManualRoute` is
     one message per train and each write replaces the last -- so the total
     the player assembled is kept here and handed to the Dividends step.

     KEYED BY CORPORATION and cleared whenever the acting one changes, the
     same shape and the same effect `routesRunThisTurn` above uses. The
     protocol id is carried rather than assumed: an optimistic sub-phase
     advance can land a render where the queue has moved on, and a total
     credited to the wrong corporation would be worse than none. */
  const [committedRouteRevenue, setCommittedRouteRevenue] = useState<{
    protocolId: number;
    total: number;
  } | null>(null);
  useEffect(() => {
    setCommittedRouteRevenue(null);
  }, [actingProtocolId]);
  /* Mirrored into a ref for the same reason `routeDraftsRef` is:
     `declareDividendsChoice` reads this, and the forced-withhold effect
     (design note #414) depends on that callback's identity. Adding a
     frequently-changing value to its dependency array would rebuild the
     callback and re-arm the effect that dispatches on the player's behalf --
     a re-render becoming a transaction. The ref keeps the read current
     without touching identity. */
  const committedRouteRevenueRef = useRef<{ protocolId: number; total: number } | null>(null);
  useEffect(() => {
    committedRouteRevenueRef.current = committedRouteRevenue;
  }, [committedRouteRevenue]);
  /* ==================================================================
   *  DESIGN NOTE 484: "IT SKIPPED ROUTES" IS A FACT THREE PLACES NEED
   * ==================================================================
   *
   * REPORTED: a corporation that cannot run is still walked through Run
   * Routes and Dividends, and Dividends still offers Skip at $0.
   *
   * The observation existed -- `routesRunThisTurn` -- and exactly one
   * reader consumed it, to decide whether `last_route_revenue` was stale.
   * Everything else that needed it re-asked a DIFFERENT question
   * (`noEarnableRevenue`, which probes the pathfinder) and the two disagree
   * in the gap that produced every symptom in the report:
   *
   *   `maxRouteRevenue` returns `null` -- "could not tell" -- for a
   *   corporation with a train and no token on the board, and `null` is not
   *   `0`, so `noEarnableRevenue` was `null` and the forced-withhold effect
   *   declined to fire. The corporation sat on Dividends waiting for a
   *   click, having already been auto-skipped past Routes one step earlier.
   *   The two mechanisms had different opinions about the same corporation
   *   in the same turn.
   *
   * Hoisted here, next to the state it reads, so the three consumers below
   * share one answer instead of three approximations of it. */
  const skippedRoutesThisTurn =
    routesRunThisTurn?.protocolId === actingProtocolId && routesRunThisTurn.ran === false;
  /* Design note #275: read by the canvas click handler, which must see the
     CURRENT draft without being rebuilt on every click. Mirrors, written
     alongside the state exactly as the sandbox atoms are (design note
     #265) -- the state stays the rendering source of truth. */
  const routeDraftsRef = useRef<Readonly<Record<number, RoutePoint[]>>>(routeDrafts);
  const activeTrainIndexRef = useRef<number>(activeTrainIndex);
  useEffect(() => {
    routeDraftsRef.current = routeDrafts;
  }, [routeDrafts]);
  useEffect(() => {
    activeTrainIndexRef.current = activeTrainIndex;
  }, [activeTrainIndex]);
  /* Design note #266: WHICH TOOL DREW WHAT IS ON SCREEN.
     `routeSelectMode` stays as the CANVAS flag -- whether map clicks are
     being routed to the builder -- and this says which of the two drafting
     tools the panel's toggle is showing as chosen. They are separate
     because they answer different questions: one gates an input, the other
     labels a state, and both auto and manual want the input on. */
  /* Design note #493: `routeBuildMode` is GONE. Design note #286 argued here
     about which position the toggle should open on, and the honest answer
     turned out to be that neither position did anything -- the map is
     editable for the whole sub-phase either way (design note #266's
     `routeSelectMode` effect just below). What #286 was really defending is
     kept: the step still DRAFTS on arrival, so the table shows the tracer's
     answer rather than an empty grid. */

  // Design note #33: hiding the toggle is not enough -- route mode also
  // rewires the Rail Map's click handling, so a mode left ON when its phase
  // ends would keep swallowing tile-lay clicks with no visible control to
  // turn it back off. Force it off (and drop the half-built path with it)
  // the moment the Routes sub-phase ends, in the same place the flag lives
  // rather than in the bar that renders the switch.
  const inRunTrainsSubPhase =
    (gameState?.current_round_type ?? null) === "OperatingRound" && orSubPhase === "Routes";
  useEffect(() => {
    if (inRunTrainsSubPhase) return;
    setRouteSelectMode(false);
    setRouteDrafts({});
    setActiveTrainIndex(0);
    setRouteFeedback(null);
  }, [inRunTrainsSubPhase]);

  /* Design note #266: entering the step ENGAGES the builder.
     The panel is now on screen for the whole sub-phase, and a visible
     builder whose map clicks go nowhere is worse than no builder -- the
     player clicks a city, nothing happens, and the only clue is a control
     they already appear to have selected. There is nothing else to click
     the map for during Run Routes: tiles belong to Track and tokens to
     Tokens, both of which have already passed. */
  useEffect(() => {
    if (!inRunTrainsSubPhase) return;
    setRouteSelectMode(true);
  }, [inRunTrainsSubPhase]);



  /** Design note #275: clears ONE train's route, or every train's when
   *  given `null` -- the panel offers both, because a player fixing one bad
   *  route should not lose the two good ones beside it. */
  const handleClearRoute = useCallback((trainIndex: number | null) => {
    setRouteDrafts((prev) => {
      if (trainIndex === null) return {};
      if (!(trainIndex in prev)) return prev;
      const next = { ...prev };
      delete next[trainIndex];
      return next;
    });
    setRouteFeedback(null);
    /* Design note #493: this used to flip the toggle to "Manual" so the
       control agreed with the button's own tooltip. With no toggle the
       agreement is automatic -- clearing leaves an empty draft the player
       fills by clicking, which is what the map has always allowed. */
  }, []);

  /** Design note #275: which train the map is drafting for. */
  const handleSelectRouteTrain = useCallback((trainIndex: number) => {
    setActiveTrainIndex(trainIndex);
    setRouteFeedback(null);
  }, []);

  /* ==================================================================
   *  DESIGN NOTE 202: AUTO ROUTE IS A DRAFTING TOOL
   * ==================================================================
   *
   * The button had been disabled since Audit G-13 removed
   * `ExecuteOperatingRound`, with a tooltip explaining that the contract's
   * own pathfinder has no message reaching it. That is true of the CONTRACT
   * and irrelevant to the BUTTON: a player asking for a route to be drawn
   * for them is asking the UI to pre-fill the manual builder, which needs no
   * chain at all. The result leaves through the same `RunManualRoute` the
   * player could have clicked out by hand, and the contract validates it
   * exactly as it validates a hand-built one.
   *
   * So this fills in the route drafts and then gets out of the way. It is
   * explicitly a SUGGESTION -- `autoTraceRoute`'s own design note #0 lists
   * what it does not check, and every one of those remains
   * `pathfinding.rs`'s -- and the player can extend, trim or clear whatever
   * it drew. Naming it "Auto Route" rather than "Best Route" is deliberate
   * for the same reason design note #186 refused "Calculate BEST Route": a
   * client-side claim of optimality that the contract disagreed with would
   * be worse than no button.
   */
  const handleAutoRoute = useCallback(() => {
    const corporation = gameState?.public_companies.find(
      (entry) => entry.company_id === actingProtocolId,
    );
    /* Design note #250: NO TRAIN, NO ROUTE. A corporation with an empty
       roster has nothing to run, so drafting one would produce a priced
       path it can never declare -- a revenue figure with no train behind
       it, which is the "mock revenue" this block exists to stop. */
    if ((corporation?.owned_trains?.length ?? 0) === 0) {
      setRouteFeedback(NO_TRAIN_ROUTE_REASON);
      return;
    }

    /* ==================================================================
     *  DESIGN NOTE 280: THE BEST SET, CHOSEN JOINTLY
     * ==================================================================
     *
     * Design note #275 drafted one train at a time, biggest first, handing
     * each the hexes its predecessors took. Two things were wrong with that
     * and both are now `assignRouteSet`'s (its own design notes #4 and #7):
     *
     *   IT BARRED WHOLE HEXES. Two trains may legally cross one hex on
     *   different curves, and may reach the two separate stations of an OO
     *   tile. Occupancy is per RAIL now.
     *
     *   IT DECIDED IN ORDER. The best route for the 5-train may be the only
     *   route the 3-train could have run, and a greedy pass cannot see that
     *   because it commits the 5-train before looking at the 3. The set is
     *   chosen jointly against the combined payout.
     *
     * This loop is therefore gone entirely -- what remains is unpacking the
     * answer into per-train drafts. */
    const result = assignRouteSet({
      mapGrid,
      era: ERA_FOR_PHASE_TINT[currentPhase?.tint ?? "yellow"],
      // A route must touch a city this corporation has a token in, so its
      // tokens are the only legal places to start looking.
      startHexes: corporation?.station_token_hexes ?? [],
      trains: ownedTrainRoster.map((train) => ({
        trainIndex: train.trainIndex,
        // `999` is the Diesel's unlimited; 4 is the safe default for a model
        // this build's catalog does not know.
        maxRevenueCentres: train.maxDistance ?? 4,
      })),
    });

    const drafted: Record<number, RoutePoint[]> = {};
    for (const assignment of result.assignments) {
      drafted[assignment.trainIndex] = assignment.path.map((point) => ({
        q: point.q,
        r: point.r,
        hexLabel: point.hexLabel,
      }));
    }

    const anyDrafted = Object.keys(drafted).length > 0;
    if (!anyDrafted) {
      setRouteFeedback(result.reason ?? NO_TRAIN_ROUTE_REASON);
      return;
    }

    setRouteDrafts(drafted);
    // Park the cursor on a train that actually has a route, so the panel's
    // highlighted row and the Clear Route button both refer to something.
    const firstDrafted = ownedTrainRoster.find((train) => drafted[train.trainIndex]);
    if (firstDrafted) setActiveTrainIndex(firstDrafted.trainIndex);
    // Turning the canvas flag on is part of the answer, not a side effect:
    // the drafted path is meant to be editable, and editing it means map
    // clicks have to reach the builder.
    setRouteSelectMode(true);
    /* Design note #266: NO SUCCESS MESSAGE. This used to set
       "Auto Route drafted 5 hexes worth $180. Edit it by clicking hexes, or
       clear it and build your own." -- a red string, on the happy path,
       restating the hex chain and the value that the panel renders two rows
       above it, then explaining the panel's own controls. Every fact in it
       is now on screen as a fact rather than as a sentence about one. See
       `RoutePlannerPanel`'s design note #3. */
    setRouteFeedback(null);
  }, [gameState, actingProtocolId, mapGrid, currentPhase, ownedTrainRoster]);

  /* Design note #286: ARRIVING AT THE STEP MEANS ACTUALLY DRAFTING.
     An empty table on arrival is worse than a drafted one -- the tracer's
     answer is the better starting point for most players and an expert can
     edit it, which is the whole argument #286 made.

     Design note #493: the `routeBuildMode !== "auto"` guard is gone with the
     toggle. It only ever skipped the draft when the player had switched to a
     mode that behaved identically, so removing it makes the step draft
     unconditionally -- which is what it did in practice, since the toggle
     opened on auto.

     Guarded per corporation rather than per render: the tracer is a search,
     and re-running it after every board change would overwrite a route the
     player has since edited by hand. One draft on arrival, then it is
     theirs -- and `AutoRouteButton` is how they ask for another. */
  const autoDraftedForRef = useRef<number | null>(null);
  useEffect(() => {
    if (!inRunTrainsSubPhase) {
      autoDraftedForRef.current = null;
      return;
    }
    if (autoDraftedForRef.current === actingProtocolId) return;
    autoDraftedForRef.current = actingProtocolId;
    handleAutoRoute();
  }, [inRunTrainsSubPhase, actingProtocolId, handleAutoRoute]);

  /* Design note #493: re-draft on demand. What the toggle's "auto" position
     did minus the mode change -- the tracer runs, the map stays editable,
     and nothing is left switched on. This is how a player abandons an edit
     and returns to the machine's answer. */
  const handleAutoRouteAgain = useCallback(() => {
    setRouteFeedback(null);
    setRouteSelectMode(true);
    handleAutoRoute();
  }, [handleAutoRoute]);

  const handleRouteHexClick = useCallback(
    (info: {
      q: number;
      r: number;
      hexLabel: string;
      boardLabel: string | null;
      clientX: number;
      clientY: number;
    }) => {
      /* ==================================================================
       *  DESIGN NOTE 243: THE WAYPOINT CARRIES THE LABEL, NOT THE NAME
       * ==================================================================
       *
       * REPORTED BUG: auto-route prices a route correctly and manual route
       * resolves to $0.
       *
       * This stored `info.hexLabel` -- which is `describeHex`'s DISPLAY
       * string, "New York (G19)" -- as the waypoint's label. Two things
       * followed, and only the first was visible:
       *
       *   IT PRICED AT ZERO. `sandboxRouteBreakdown` looks each stop up in a
       *   table keyed on the canonical label, so every stop missed and the
       *   whole route totalled nothing. `autoTraceRoute` builds its labels
       *   from `STATIC_BOARD_HEXES` and therefore priced identical routes
       *   correctly -- which is precisely the asymmetry reported, and the
       *   reason it looked like two different revenue calculations when it
       *   was always one being fed two different kinds of string.
       *
       *   IT WOULD HAVE BEEN REJECTED ON CHAIN. The same value goes into
       *   `RunManualRoute`'s `path[].hex`. The contract resolves that
       *   against its own hex table, so a submitted manual route named a hex
       *   that does not exist.
       *
       * `boardLabel` is the identifier (design note #242). `hexLabel` stays
       * the display string and is still what the feedback messages below
       * quote, because "Altoona (H12) has no track" reads better than
       * "H12 has no track".
       */
      const boardLabel = info.boardLabel;
      if (boardLabel === null) return;
      const point: RoutePoint = { q: info.q, r: info.r, hexLabel: boardLabel };

      /* Design note #266/#493: EDITING A DRAFT MAKES IT YOURS. This used to
         flip the toggle to "Manual", because a control still reading
         "Auto-Route" would be crediting the tracer for a path the player had
         since changed. With no toggle there is nothing to correct: the click
         edits the draft, which is what it always did underneath the label. */

      /* ==================================================================
       *  DESIGN NOTE 256: A ROUTE RUNS BETWEEN TWO PAYING STOPS
       * ==================================================================
       *
       * REPORTED: routes should start and end at a city, town or red
       * off-board hex rather than anywhere the player happens to click.
       *
       * 1830's definition of a route is a run between two REVENUE CENTRES,
       * with any amount of plain track in between. The builder enforced only
       * that each click had track on it, so a route could begin and end on
       * bare connectors -- which the contract then refused for failing the
       * two-centre minimum, after the player had drawn the whole thing.
       *
       * The FIRST click is refused outright when it is not a revenue centre:
       * there is no ambiguity about what it is, and refusing it costs the
       * player one misplaced click rather than a whole path. The LAST is
       * left to the readout and the Run button -- it cannot be enforced on
       * click, because every intermediate click is momentarily "the last"
       * and refusing plain track mid-draw would make it impossible to cross
       * any.
       */
      /* Design note #264: A TOWN IS NOT A TERMINUS.
         This used to test `hexStopValue > 0` -- "does this hex pay
         anything" -- which is the right question for revenue and the wrong
         one for termination. Towns pay, and 1830 does not let a route begin
         or end on one: they are passed THROUGH, adding their value to a run
         between two cities. `isRouteTerminusHex` asks the question that
         actually applies. */
      // Design note #275: the ACTIVE train's draft. Every rule below is
      // about one train's own chain, so they all read this rather than a
      // single global route.
      const current = routeDraftsRef.current[activeTrainIndexRef.current] ?? [];
      if (current.length === 0 && !isRouteTerminusHex(mapGrid, boardLabel)) {
        setRouteFeedback(
          `${info.hexLabel} cannot START a route. Routes begin at a city or a red off-board hex — towns and plain track are passed through.`,
        );
        return;
      }

      /* Design note #186: A WAYPOINT NEEDS TRACK.
       *
       * Any hex could be added, including bare ground the corporation has
       * never built on -- so a "route" could be drawn across empty prairie,
       * priced, and submitted. The adjacency check below refuses a
       * DISCONNECTED chain; it has nothing to say about a connected chain of
       * hexes with no rails on them.
       *
       * Preprinted track counts: the gray hexes and the landmarks ship with
       * rails the board draws and trains may run on, so `liveEdgesForHex` --
       * which reads a laid tile's rotated mask AND the preprinted geometry --
       * is the right test rather than "is there a tile record". */
      if (liveEdgesForHex(mapGrid, info.q, info.r).length === 0) {
        setRouteFeedback(
          `${info.hexLabel} has no track. Lay a tile there first, or pick a hex the network already runs through.`,
        );
        return;
      }

      setRouteDrafts((all) => {
        const trainIndex = activeTrainIndexRef.current;
        const prev = all[trainIndex] ?? [];
        const write = (next: RoutePoint[]) => ({ ...all, [trainIndex]: next });
        const last = prev[prev.length - 1];
        // Clicking the most recently added point again is a quick one-step
        // undo, rather than a no-op or a rejected duplicate.
        if (last && last.q === point.q && last.r === point.r) {
          setRouteFeedback(null);
          return write(prev.slice(0, -1));
        }
        if (prev.length === 0) {
          setRouteFeedback(null);
          return write([point]);
        }

        // Clicking a hex the route already passes through, other than the
        // last one, would make the chain visit it twice -- and 1830 pays a
        // hex once per pass, so the drawing and the pricing would disagree.
        // Refused with the reason rather than silently ignored.
        if (prev.some((entry) => entry.q === point.q && entry.r === point.r)) {
          setRouteFeedback(
            `${point.hexLabel} is already on this route. A route may not visit the same hex twice — click ${last.hexLabel} to step back instead.`,
          );
          return all;
        }

        /* Design note #276: ADJACENT CLICKS ARE UNCHANGED.
           A neighbouring hex is appended exactly as before, which is what
           keeps hex-by-hex drawing available for disambiguating a branch --
           the bridge below only fills gaps the player chose to leave. */
        if (axialHexDistance(last, point) === 1) {
          setRouteFeedback(null);
          return write([...prev, point]);
        }

        /* ==================================================================
         *  DESIGN NOTE 276: THE GAP BETWEEN TWO STOPS IS NOT A DECISION
         * ==================================================================
         *
         * REPORTED: manual routing forces a click on every plain track hex
         * between two cities.
         *
         * The old rule here refused any non-adjacent click outright --
         * "route points must chain through neighboring hexes" -- which is a
         * true statement about routes and the wrong thing to ask of a
         * player. The chain has to be connected; it does not have to be
         * typed in one hex at a time, and on a built-up board nineteen of
         * every twenty clicks had exactly one legal answer.
         *
         * `bridgeWaypoints` walks the live track between the two, preferring
         * plain track over a shortcut through some third city (see its own
         * design note #5 for why that preference matters -- an unasked-for
         * city costs both revenue and a stop of the train's capacity).
         *
         * A FAILED BRIDGE IS STILL REFUSED, and says so. Two hexes with no
         * rails between them are not a route, and filling that gap with a
         * straight line would be the class of plausible fiction this
         * codebase has deleted twice already. */
        const bridge = bridgeWaypoints(
          mapGrid,
          last,
          point,
          // A route is a simple path, so the bridge may not loop back
          // through hexes the player has already routed over.
          new Set(prev.map((entry) => `${entry.q},${entry.r}`)),
        );
        if (!bridge) {
          setRouteFeedback(
            `No track path from ${last.hexLabel} to ${point.hexLabel}. Lay the missing tiles, or click through the hexes you want the route to take.`,
          );
          return all;
        }
        setRouteFeedback(null);
        return write([...prev, ...bridge]);
      });
    },
    // `mapGrid` joins for design note #186's track check -- a stale closure
    // would judge a waypoint against the board as it was before the last
    // tile lay, and refuse a hex the player has just built on.
    //
    // The draft and the active train are read through REFS (design note
    // #275), so neither joins this list. They change on every click, and a
    // handler identity that changed with them would rebuild the canvas's
    // click prop mid-draw -- the same staleness trap `routePoints.length`
    // used to sit in, one level up. The ERA is not needed either: design
    // note #264 replaced the value test with an archetype test, and whether
    // a hex holds a city does not change with the phase.
    [mapGrid],
  );

/* `routeHopCount` is GONE (design note #156). It counted hops between
   selected hexes and was compared against a train's number, which is the
   classic 18xx misreading: a 2-train is limited to two REVENUE CENTRES, not
   two hexes of travel. `routeBreakdown.centres` replaced it as the capacity
   figure and `routeBreakdown.hexes` as the "how far did I click" figure --
   deleted rather than left unused so nothing can quietly start comparing
   against it again. */

  // Live preview of what the selected stops are worth. Recomputed as the
  // player clicks, which is the whole point -- a number that only appears
  // after dispatch cannot be used to compare two candidate routes.
  //
  // Below two points there is no route to price, and showing "$0" for a
  // single click would read as "this city is worthless" rather than "you
  // have not drawn a route yet".
  /* ==================================================================
   *  DESIGN NOTE 275: EVERY DRAFT, PRICED
   * ==================================================================
   *
   * One memo over the whole roster rather than the old single
   * `routeBreakdown`. Each entry is what `RoutePlannerPanel` renders as one
   * row and what `handleRunTrains` dispatches as one message, so the panel,
   * the total and the dispatch cannot disagree about which routes count. */
  /** Design note #474: the acting corporation's station tokens, as `(q, r)`
   *  pairs -- what a route must touch one of. Derived once rather than
   *  looked up per draft: every train's route is judged against the same
   *  corporation's tokens, and re-finding the company inside the map would
   *  make the rule look per-train when it is per-corporation. */
  const routeTokenHexes = useMemo<ReadonlyArray<readonly [number, number]>>(
    () =>
      gameState?.public_companies.find((entry) => entry.company_id === actingProtocolId)
        ?.station_token_hexes ?? [],
    [gameState, actingProtocolId],
  );

  const trainDrafts = useMemo<TrainRouteDraft[]>(() => {
    const era = ERA_FOR_PHASE_TINT[currentPhase?.tint ?? "yellow"];
    return ownedTrainRoster.map((train) => {
      const points = routeDrafts[train.trainIndex] ?? [];
      const breakdown =
        points.length < 2
          ? null
          : sandboxRouteBreakdown(mapGrid, routePointsToWaypoints(points), era);
      /* ==================================================================
       *  DESIGN NOTE 285: THE STOP COUNT IS THE STOP LIST
       * ==================================================================
       *
       * REPORTED: a 2-train running City -> Town -> City reads "2/2 stops"
       * in Manual mode and can be submitted, while Auto-Route rejects it.
       *
       * The arithmetic was audited across the whole board before changing
       * anything, and it holds: `sandboxRouteBreakdown` counts every hex
       * that pays, towns included, so that route reports three stops in
       * both modes and no reachable hex on the board prices at $0. The
       * manual bridge includes the town too. There was no divergence to
       * find in the counting itself.
       *
       * WHAT THERE WAS is a hole one level up, and it produces exactly the
       * reported symptom -- a route that cannot be blocked:
       *
       *   `maxDistance` comes from `MOCK_TRAIN_CATALOG`, and a model the
       *   catalog does not know returns `undefined`. The old test read
       *   `maxDistance !== undefined && centres > maxDistance`, so an
       *   unrecognised train had NO capacity at all: every route passed,
       *   however many stops it visited, and the readout printed a bare
       *   count with no limit beside it. Any chain reporting a model this
       *   build does not carry -- or any future train -- lands there.
       *
       * The cap now falls back rather than vanishing. An unknown train is
       * treated as the smallest real one, which is the conservative
       * direction: it can refuse a route the contract would have allowed,
       * and it cannot wave through one the contract will refuse.
       *
       * AND THE COUNT IS NOW `stops.length` -- literally the list the panel
       * renders. The two were already equal by construction, and equal by
       * construction is a thing that stops being true when someone edits
       * one of them. Reading the array the reader is looking at removes the
       * possibility. */
      const centres = breakdown?.stops.length ?? 0;
      const cap = train.maxDistance ?? SMALLEST_TRAIN_CAPACITY;
      const last = points[points.length - 1];
      return {
        trainIndex: train.trainIndex,
        model: train.model,
        maxDistance: train.maxDistance,
        hexLabels: points.map((point) => point.hexLabel),
        stops: breakdown?.stops ?? [],
        /* Design note #250: `null`, not `0`, for a corporation with no
           trains -- zero is a real answer meaning "worth nothing" and the
           honest answer there is that the question does not apply. */
        value: ownsAnyTrain ? (breakdown?.revenue ?? null) : null,
        revenueCentres: centres,
        // Design note #285: `999` is the Diesel's genuine "unlimited"; an
        // absent figure is ignorance and must not read as one.
        exceedsMaxDistance: cap !== 999 && centres > cap,
        // Design note #256/#264: only meaningful once there is a route.
        endsOffTerminus:
          points.length >= 2 && last !== undefined
            ? !isRouteTerminusHex(mapGrid, last.hexLabel)
            : false,
        /* ==============================================================
         *  DESIGN NOTE 474: THE TOKEN RULE, WHICH WAS NOT CHECKED AT ALL
         * ==============================================================
         *
         * A route must pass through a city this corporation holds a token
         * in. Nothing enforced that: `handleRunTrains` filtered on revenue,
         * distance and terminus, so a run drawn entirely across another
         * company's network priced up and dispatched, and the contract
         * refused it after the fact.
         *
         * ANY token, ANYWHERE on the run -- see the helper's own note for
         * why "the home hex" is the wrong rule and gets more wrong as a
         * corporation places more tokens. */
        tokenBlockReason: routeTokenBlockReason(points, routeTokenHexes),
      };
    });
  }, [ownedTrainRoster, routeDrafts, mapGrid, currentPhase, ownsAnyTrain, routeTokenHexes]);

  /* Design note #275: one overlay per drafted train, so the board shows the
     whole turn at once rather than whichever route was drawn last.

     THE COLOUR IS SHARED. All of them are this corporation's routes, so all
     of them wear its colour (design note #254) -- distinguishing them by
     hue would invent a second meaning for a channel that already answers
     "whose turn is this". The ACTIVE train's route is the one the player is
     editing, and that is what the panel's row highlight says. */
  /* ===================================================================
   *  DESIGN NOTE 373 (owner): ONE NUMBER, THREE SURFACES
   * ===================================================================
   *
   * The shared cursor lives here because all three consumers are children
   * of this shell and none of them is the parent of the others -- the map
   * is in one pane, the corporation strip in the action bar, the Route
   * Planner in a third. Lifting it is the only place they meet.
   *
   * DELIBERATELY NOT PERSISTED and deliberately not in the undo snapshot
   * (design note #310's rule is about state the DISPATCH path writes). A
   * hover cursor describes where the pointer is, which is not part of the
   * game and should not survive a reload or an undo.
   *
   * `null` is the resting state and every surface clears to it on leave,
   * so a highlight cannot outlive the pointer that caused it. */
  const [highlightedTrainIndex, setHighlightedTrainIndex] = useState<number | null>(null);

  /* Cleared when the sub-phase moves off Run Routes: the cursor describes a
     relationship between three surfaces that only two of them show outside
     that step, and a stale highlight on a chip whose panel has gone would
     be a mark nothing explains. */
  useEffect(() => {
    if (orSubPhase !== "Routes") setHighlightedTrainIndex(null);
  }, [orSubPhase]);

  const manualRouteOverlay = useMemo<RouteOverlay[]>(() => {
    const overlays: RouteOverlay[] = [];
    for (const train of ownedTrainRoster) {
      const points = routeDrafts[train.trainIndex] ?? [];
      // `drawRouteOverlays` skips anything shorter, but filtering here keeps
      // the array identity stable for the canvas's dependency check.
      if (points.length < 2) continue;
      overlays.push({
        trainLabel: `${train.model}-Train`,
        /* Design note #494: PER TRAIN. This was one corporation colour
           computed above the loop and given to every route, so overlapping
           runs were literally the same line drawn twice. */
        color: routeTrainColor(train.trainIndex),
        hexes: points.map((point) => [point.q, point.r] as [number, number]),
        // Design note #373: the join key the three surfaces share.
        trainIndex: train.trainIndex,
        /* Design note #373/#495: and the emphasis it was built for. The
           renderer has supported `primary`/`muted` since #373 -- heavier
           pen, brighter glow, the others faded to 0.32 alpha -- and
           `highlightedTrainIndex` has been fed by the planner rows and the
           train chips the whole time. Nothing connected them, so hovering a
           chip lit its own row and left the map unchanged: the mechanism
           existed at both ends and not in the middle.

           `normal` when nothing is highlighted, so a board with no cursor on
           it draws exactly as before rather than dimming everything. */
        emphasis: routeEmphasisFor(train.trainIndex, highlightedTrainIndex),
      });
    }
    return overlays;
  }, [ownedTrainRoster, routeDrafts, highlightedTrainIndex]);

  /* REMOVED with design note #162: `handleTileDispatched` and
     `handleCloseTilePopup`.

     Both were `TileSelectionPopup`'s callbacks. That component dispatched
     its own `LayTile` and reported the outcome back so this file could fold
     it into the Action Log; the radial selector instead routes its confirm
     through `runGameplayAction`, which already logs every dispatch on the
     one path every other control in this app uses. One fewer dispatch
     route, and the log entry now comes from the same place as all the
     others rather than from a second, parallel one. */


  // Design note #2 in `utils/sandboxState.ts`: in sandbox the chart is
  // DERIVED from the same corporations table the Stock Round cards read,
  // so the two can no longer disagree. `MOCK_MARKET_GRID` remains only for
  // the non-sandbox placeholder path (design note #2 at the top of this
  // file -- illustrative data never produced by a live query).
  const marketGrid = useMemo<MarketGridResponse>(
    () =>
      sandbox
        ? {
            game_id: gameId,
            // Design note #272: `sandboxMarket`, not the fixture constant.
            // The old dependency list was `[sandbox, gameId]` -- neither of
            // which ever changes mid-session, which is precisely why the
            // chart could not move.
            positions: sandboxMarketPositions(sandboxMarket),
          }
        : MOCK_MARKET_GRID,
    [sandbox, gameId, sandboxMarket],
  );

  /** Design note #306 in `WaterfallAuctionDashboard.tsx`: close the auction
   *  and open Stock Round 1. Local, because the sandbox owns its own round
   *  cursor -- `PassTurn` is what advances a real room. */
  const handleProceedToStockRound = useCallback(() => {
    setSandboxState((current) => {
      if (!current) return current;
      const next = { ...current, current_round_type: "StockRound" as const, consecutive_passes: 0 };
      sandboxStateRef.current = next;
      return next;
    });
    setSandboxWaterfall((current) =>
      current === null ? current : { ...current, waterfall_auction_active: false },
    );
    logInfoRef.current?.(
      "Round",
      "The Waterfall Auction is complete \u2014 Stock Round 1 begins.",
    );
  }, []);

  /* ==================================================================
   *  DESIGN NOTE 444: A PRIVATE POWER THAT TOUCHES THE BOARD GOES THERE
   * ==================================================================
   *
   * REPORTED: the D&H's "Place Station" button does nothing.
   *
   * It did nothing in the most literal way available: this handler marked
   * the ability spent and wrote a log line. There was no dispatch, no
   * placement and no navigation -- the button reported an action it had
   * not performed, which is the failure shape this codebase keeps removing.
   *
   * The hex-holding powers now route through the same map flow the home
   * station uses (design note #440): veil the board to the one hex the
   * power names, arm the cursor the gesture needs, and hand the player the
   * board. The ability is marked spent WHEN THE CLICK LANDS, not when the
   * button is pressed -- a player who opens the map and changes their mind
   * has not used their D&H.
   *
   * THE SHARE EXCHANGES STAY AS THEY WERE, marked and logged. They touch no
   * hex, and `ExecuteMsg` has no message for them (this file's design note
   * #1 on the panel records that the whole panel is sandbox-only for
   * exactly that reason). Routing them to a map would be theatre. */
  const handleUsePrivateAbility = useCallback(
    (ability: PrivateAbility, action: PrivateAbilityAction) => {
      const reservation = privateHexFor(ability.privateId);
      const targetsHex = action.key === "dh-tile" || action.key === "dh-token" ||
        action.key === "csl-tile";

      if (targetsHex && reservation) {
        setHomeStationPlacement({
          kind: action.key === "dh-token" ? "private-station" : "private-tile",
          companyId: actingProtocolId,
          q: reservation.q,
          r: reservation.r,
          hexLabel: reservation.hexLabel,
          abilityKey: action.key,
          returnTab: activeMainTab,
        });
        setActiveMainTab("map");
        logInfoRef.current?.(
          "Private Power",
          `${action.label} — click ${reservation.hexLabel} on the Rail Map, the only hex left lit.`,
        );
        return;
      }

      setUsedPrivateAbilities((prev) => new Set(prev).add(action.key));
      logInfoRef.current?.("Private Power", `${action.label} — ${ability.description}`);
    },
    [actingProtocolId, activeMainTab],
  );

  const logInfo = useCallback((label: string, detail: string) => {
    const id = nextLogEntryId++;
    const timestamp = new Date().toLocaleTimeString();
    const timestampMs = Date.now();
    setActionLog((log) => [
      { id, label, status: "info", detail, timestamp, timestampMs, round: roundLabelRef.current ?? undefined },
      ...log,
    ]);
  }, []);

  /* `logInfo` is defined below the handler that uses it, so the handler
     reads it through a ref rather than forcing a reorder of a 6000-line
     file for one call. */
  const logInfoRef = useRef<((label: string, detail: string) => void) | null>(null);
  useEffect(() => {
    logInfoRef.current = logInfo;
  }, [logInfo]);

  /* ===================================================================
   *  DESIGN NOTE 331 (cont.): PAYING THE PRIVATES
   * ===================================================================
   *
   * Reached through a ref for the same reason `logInfoRef` exists: the
   * round-transition effect that fires this is declared ~1300 lines above,
   * and this handler needs `logInfo` and the sandbox state refs, which are
   * not available up there. A ref is the established shape in this file for
   * exactly that ordering problem.
   *
   * It reads and writes `sandboxStateRef` rather than `sandboxState` for
   * design note #265's reason -- the effect fires inside a render pass in
   * which the state variable may still be the previous value, and paying
   * against a stale board would credit the wrong owners.
   */
  const payPrivateRevenue = useCallback(() => {
    const before = sandboxStateRef.current;
    if (!before) return;
    const result = applyPrivateRevenue(before);
    // Identity, not length: `applyPrivateRevenue` returns the same object
    // when nothing is owed, so this is also the "no re-render" check.
    if (!result || result.state === before) return;

    sandboxStateRef.current = result.state;
    setSandboxState(result.state);

    const labelForAddress = (address: string) =>
      sandboxPlayerLabel(address) ?? truncateAddress(address);
    const labelForCompany = (companyId: number) =>
      before.public_companies.find((entry) => entry.company_id === companyId)?.ticker ??
      `company #${companyId}`;

    for (const payout of result.payouts) {
      logInfoRef.current?.(
        "Private Revenue",
        describePrivatePayout(payout, labelForAddress, labelForCompany),
      );
    }
  }, []);

  const payPrivateRevenueRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    payPrivateRevenueRef.current = payPrivateRevenue;
  }, [payPrivateRevenue]);

  const runGameplayAction = useCallback(
    async (
      fallbackLabel: string,
      msg: GameplayExecuteMsg,
      /* Design note #439: set by the two effects that dispatch on the
         player's behalf (the sub-phase auto-skip and the forced withhold).
         Everything else is a click and defaults to `false`.

         Design note #492a: `resetRouteRevenue` marks the first
         `RunManualRoute` of a turn's batch, so the sandbox reducer starts
         its per-turn sum from zero instead of adding to the last turn's. */
      /* Design note #522: `isRemoteReplay` marks an action arriving FROM the
         Firestore log rather than from this browser's own click. It is the
         one thing that distinguishes the two directions of the loop, and
         everything else about the dispatch is identical -- which is the
         point: a replayed action must take exactly the path a local one
         takes, or the two clients run different code and diverge. */
      options?: { automatic?: boolean; resetRouteRevenue?: boolean; isRemoteReplay?: boolean },
    ) => {
      /* ==================================================================
       *  DESIGN NOTE 262: THE LOG DESCRIBES THE EVENT, NOT THE MESSAGE
       * ==================================================================
       *
       * Every call site used to hand in its own label, and they were the
       * contract's variant names -- "RunManualRoute", "BuyHardwareFromPool
       * (mock)", "DeclareDividends: Pay (mock)". None of them said WHO
       * acted, several leaked internals, and the "(mock)" suffixes outlived
       * the mocks they were warning about.
       *
       * Deriving the label here rather than at the call site is the point:
       * one place turns a message into a sentence, so a new dispatch cannot
       * forget to write one and an old one cannot drift from what it sends.
       * `describeGameplayAction` reads the state BEFORE the action applies,
       * which is the only state available at dispatch time and the more
       * useful one to report against (its design note #1).
       *
       * The passed label survives as the fallback for messages with nothing
       * better to say -- a vaguer sentence than the variant name would be a
       * downgrade dressed as an improvement. */
      const describeContext = {
        gameState,
        mapGrid,
        era: ERA_FOR_PHASE_TINT[currentPhase?.tint ?? "yellow"],
        labelForAddress: (address: string) =>
          sandboxPlayerLabel(address) ?? truncateAddress(address),
        marketPrices: Object.fromEntries(
          (marketGrid?.positions ?? []).map((entry) => [entry.company_id, Number(entry.price)]),
        ),
        /* Design note #434: steps from the CELL. This took a bare price and
           re-derived a coordinate from it, so the log quoted the same wrong
           destination the readout did. `marketGrid.positions` is the same
           source the panel reads, so the sentence and the screen agree. */
        projectPrice: (companyId: number, choice: "pay" | "withhold") =>
          projectDividendFrom(
            marketGrid?.positions.find((p) => p.company_id === companyId) ?? null,
            choice,
          )?.price ?? null,
        /* Design note #478: the step the button was pressed FROM. Read from
           the state variable rather than a ref because the cursor only ever
           moves as a result of a dispatch, so it cannot be mid-flight the
           way the sandbox atoms can. */
        orSubPhase,
      };
      /* Design note #265: seeded from the BEFORE state, then re-derived
         against the resolved one inside the sandbox branch. A live chain has
         no resolved state to offer at dispatch time, so this is what it
         keeps -- which is why `afterState` is optional in the context rather
         than required. */
      let label = describeGameplayAction(msg, describeContext) ?? fallbackLabel;

      const id = nextLogEntryId++;
      const timestamp = new Date().toLocaleTimeString();
      const timestampMs = Date.now();

      // Design note #23: the read-only gate for dispatch path (1). Every
      // gameplay control on this screen except the tile popup -- the
      // Contextual Action Bar's twenty-odd buttons, the Waterfall dashboard,
      // the train-offer panel -- funnels through this one function, which is
      // why the check belongs here rather than on each button. Disabling
      // buttons individually would be a list that has to be kept complete
      // forever; this is one invariant a new button cannot opt out of.
      //
      // The tile popup is path (2) and is NOT covered here -- it dispatches
      // directly and is gated by not being mounted. See `AppShellProps`.
      //
      // Logged rather than silently dropped, so a spectator who finds a
      // control this pass failed to hide gets an explanation instead of a
      // dead click. The chain would refuse them anyway -- a spectator is not
      // in `player_addresses` -- but failing here is instant, free and
      // legible, where failing on-chain costs a signature and returns an
      // error about turn order.
      // Sandbox: apply the action to the LOCAL reducer instead of signing
      // anything. Nothing is broadcast and no wallet is touched -- the
      // message never leaves this function -- but the mock state advances, so
      // the turn moves, balances change, and the UI re-renders exactly as it
      // would against a chain.
      //
      // Deliberately still not a chain dispatch: `applySandboxAction` moves
      // turn pointers and counters, and knows no rules. See
      // `utils/sandboxSession.ts` design note 0 for why that boundary is the
      // whole design rather than an unfinished edge.
      if (sandbox) {
        /* ==================================================================
         *  DESIGN NOTE 522: IN A ROOM, THE LOG IS THE ONLY WAY IN
         * ==================================================================
         *
         * The event-sourcing loop, and the whole reason it is ONE branch
         * rather than a parallel path: a local click in a room does not
         * touch state at all. It appends to Firestore and stops. The
         * `onSnapshot` listener then replays it back through this same
         * function with `isRemoteReplay`, which is what actually moves the
         * board.
         *
         * SO THE LOCAL PLAYER TAKES THE SAME ROUTE AS EVERYONE ELSE. That
         * costs a round trip before your own action appears, and it buys the
         * property that makes this design work: there is exactly one order
         * of operations, the one in the log, and every client -- including
         * the one that acted -- derives its state from it. An optimistic
         * local apply would give the actor a state nobody else has, and
         * reconciling it would mean rewinding and replaying on every
         * remote action.
         *
         * `appliedIndexRef` is the cursor, and the append reads it for the
         * next index. It is a ref rather than state because this callback
         * must not be rebuilt when it moves -- `runGameplayAction` sits in
         * the dependency array of the auto-skip and forced-withhold effects
         * (design note #439), and rebuilding it re-arms effects that
         * DISPATCH.
         *
         * SOLO SANDBOX IS UNTOUCHED. No room, no interception, no await on a
         * network -- the branch below runs exactly as it did before. */
        if (sandboxRoomRef.current && options?.isRemoteReplay !== true) {
          const ok = await appendSandboxAction(
            sandboxRoomRef.current,
            appliedIndexRef.current,
            sandboxSeatRef.current,
            msg,
          ).catch(() => false);
          if (!ok) {
            setSandboxRoomError("Could not reach the room — that action was not sent.");
          }
          return;
        }

        /* Design note #522a: the tile grid is its own atom and no reducer
           in `sandboxSession` touches it -- so the one message that changes
           it applies it here, on the single path both a local click and a
           replayed action take. Derived entirely from the message's own
           parameters, which is what makes it reproducible from the log. */
        if ("LayTile" in msg) {
          const lay = msg.LayTile;
          setMapGrid((current) =>
            applySandboxLayTile(current, lay.q, lay.r, lay.tile_id, lay.orientation),
          );
        }

        /* ==================================================================
         *  DESIGN NOTE 265: THE LOG REPORTS WHAT HAPPENED, NOT WHAT WAS ASKED
         * ==================================================================
         *
         * REPORTED: the log reads the state before the action resolves --
         * "2/5 remaining" logged at the moment a purchase is clicked, rather
         * than the 1/5 that is true once it lands.
         *
         * Design note #1 in `actionLog.ts` argued for describing the BEFORE
         * state, on the grounds that it is the only state available at
         * dispatch time. That is true on a chain and was never true here: the
         * sandbox reducer is synchronous, so the resolved state is one
         * function call away. The argument was right about the constraint and
         * wrong about which side of it the sandbox sits on.
         *
         * THIS BLOCK NOW RESOLVES FIRST AND LOGS SECOND. It also fixes two
         * real bugs that the functional-updater style was hiding:
         *
         *   THE CHARGE CROSSED THE ATOMS IN THE WRONG ORDER. The waterfall's
         *   charge was captured inside `setSandboxWaterfall`'s updater and
         *   read inside `setSandboxState`'s. React invokes each hook's queue
         *   as that hook is evaluated during render, and `sandboxState` is
         *   declared FIRST -- so the charge was read before it was written,
         *   and an auction purchase never actually debited the buyer.
         *
         *   A LOOP OF DISPATCHES COLLAPSED. `handleBuyTrainsFromBank` awaits
         *   N purchases in a row, and `sandboxState` in this closure does not
         *   refresh between iterations. Reading it directly would have
         *   applied every purchase to the same base state.
         *
         * A REF fixes both: it is written synchronously, so each dispatch
         * sees the previous one's result, and the ordering is explicit rather
         * than dependent on hook declaration order.
         */
        const before = sandboxStateRef.current;

        // Design note #178: UNDO. Snapshot before mutating -- except for
        // undo itself, which would otherwise push the state it is about to
        // discard and make the button a no-op that consumes a stack slot.
        //
        // Design note #310: every atom, read from the REFS rather than from
        // the rendered values. The refs are what this dispatch is about to
        // overwrite, so they are what "before" means here; the state
        // variables in this closure may be a render behind when several
        // actions fire in one tick.
        /* ==============================================================
         *  DESIGN NOTE 475: AN AUTOMATIC ACTION LEAVES NO TRACE
         * ==============================================================
         *
         * REPORTED: Undo reverts entire turns, and can revert the PREVIOUS
         * player's.
         *
         * Design note #439 pushed a snapshot for every dispatch and taught
         * Undo to walk past the automatic ones. The walk is what crossed
         * turn boundaries: a corporation whose turn opens with three
         * auto-skips has three automatic entries stacked on the previous
         * player's `PassTurn`, and one press walked all the way down to it.
         *
         * Not pushing is the simpler and stricter answer. The stack then
         * holds only decisions the player made, so Undo pops exactly one and
         * cannot reach past a turn boundary it did not create -- `PassTurn`
         * is a player action and stops it.
         *
         * WHAT AN AUTOMATIC ACTION IS: the sub-phase auto-skip and the
         * forced $0 withhold, and nothing else. Both are the game acting on
         * a rule with no decision in it, so there is nothing for a player to
         * take back -- and both RE-DERIVE when the state they followed from
         * is restored, which is why nothing is lost by not recording them.
         *
         * `UndoLastAction` still excludes itself, for design note #178's
         * original reason: it would otherwise push the state it is about to
         * discard and make the button a no-op that consumes a stack slot. */
        if (!("UndoLastAction" in msg) && before && options?.automatic !== true) {
          setSandboxHistory((stack) =>
            [
              ...stack,
              {
                state: before,
                mapGrid,
                subPhase: orSubPhase,
                waterfall: sandboxWaterfallRef.current,
                market: sandboxMarketRef.current,
                settledPrices: settledPrivatePricesRef.current,
                /* Always `false` now -- design note #475 declines to push an
                   automatic entry at all. Kept on the record so
                   `undoTargetIndex`'s safety net has a field to read and the
                   invariant is expressible rather than implied. */
                automatic: false,
                /* Design note #479: the BEFORE-state sentence, which is the
                   one that exists at this point in the function. The
                   resolved re-description happens further down and differs
                   only in figures it can now report exactly (a treasury
                   balance, a depot count) -- never in who acted or what
                   they did, which is all an undo line quotes. */
                label,
                actor: actingActor(describeContext),
              },
            ].slice(-SANDBOX_HISTORY_LIMIT),
          );
        }

        /* Design note #261: the auction's own atom, advanced alongside the
           game state. `applySandboxWaterfallAction` returns the cash it
           implies rather than reaching across into player wallets, so the
           charge is applied here through the ordinary path. */
        let after = before;
        const waterfallBefore = sandboxWaterfallRef.current;
        if (waterfallBefore) {
          const result = applySandboxWaterfallAction(
            waterfallBefore,
            msg,
            before?.player_addresses ?? [],
          );
          sandboxWaterfallRef.current = result.waterfall;
          setSandboxWaterfall(result.waterfall);

          /* Design note #334a: a LIST of charges, and not all of them the
             actor's -- an auto-awarded private is charged to its lone
             bidder, who may not be the player who just moved. */
          for (const { player, amount } of result.charges) {
            if (!after) break;
            after = {
              ...after,
              player_cash: after.player_cash.map((entry: { player: string; cash_vgp: string }) =>
                entry.player === player
                  ? {
                      ...entry,
                      cash_vgp: String(Math.max(0, (Number(entry.cash_vgp) || 0) - amount)),
                    }
                  : entry,
              ),
            };
          }

          /* ==============================================================
           *  DESIGN NOTE 303: A WON PRIVATE HAS TO BECOME AN OWNED ONE
           * ==============================================================
           *
           * REPORTED: sold private companies disappear from the screen.
           *
           * The dashboard already renders a dimmed "Sold to X for $Y"
           * card, and it lists them from `gameState.private_companies`
           * filtered on `owner !== null`. Nothing ever set that owner.
           * `applySandboxWaterfallAction` REPORTS the win -- it returns
           * `won` so the caller can log it -- and the waterfall's own
           * `removePrivate` drops the company off the live list. So the
           * card left the auction grid and never arrived in the sold one.
           *
           * The reducer reporting rather than writing is the right split
           * (it owns the auction atom, not the game state), so the write
           * belongs here, where both are in hand.
           *
           * Design note #334: a LIST now. One purchase can cascade through
           * several lone-bid privates, and looping is what stops the
           * second and third from going missing the way the first once
           * did. */
          for (const { privateId, name, player, price } of result.won) {
            if (after) {
              after = {
                ...after,
                private_companies: after.private_companies.map((entry) =>
                  entry.private_id === privateId ? { ...entry, owner: player } : entry,
                ),
              };
            }
            /* The SETTLED price, which is not the same as the face value a
               `PrivateCompanyState` carries -- a private won in a
               mini-auction went for more, and the card was previously
               reduced to quoting face value with a tooltip apologising for
               it. Kept beside the state rather than written into `cost`,
               which is a printed property of the company. */
            setSettledPrivatePrices((prev) => ({ ...prev, [privateId]: price }));
            logInfo(
              "Private Won",
              `${sandboxPlayerLabel(player) ?? truncateAddress(player)} won ${name} for $${price}.`,
            );

            /* Design note #354: the B&O private hands its winner the
               corporation's presidency, free. The rule lives in
               `sandboxSession.ts` as a named function -- see its note for
               what moves, what does not, and why it is not inline here.

               Design note #399: and it is no longer granted HERE. The grant
               needs a par price, the price is the winner's to choose, and
               choosing it is a decision -- so the win raises a prompt and
               the grant happens when that prompt is answered. Granting
               first and pricing later produced a presided-over company with
               no price, which design note #387 correctly refuses to draw. */
            if (privateId === BO_PRIVATE_ID) {
              setBoParPrompt({ player });
            }
          }

          /* ==============================================================
           *  DESIGN NOTE 337 (caller half): THE ALL-PASS PAYOUT
           * ==============================================================
           *
           * The reducer reports that the table passed all the way round and
           * what the markdown cost; the money moves here, because the
           * privates' owners and revenues live on the GAME state and the
           * waterfall reducer holds only the auction document.
           *
           * `applyPrivateRevenue` is the Operating Round's own payout
           * function (design note #327), reused rather than reimplemented --
           * so "who owns it", "is it closed", "does a corporate owner get
           * it" and "who funds it" have exactly one answer in this app. */
          if (result.markdown) {
            logInfo(
              "Waterfall",
              `Everyone passed \u2014 ${result.markdown.name} drops from $${result.markdown.from} to $${result.markdown.to}.`,
            );
          }
          if (result.allPassed && after) {
            const revenue = applyPrivateRevenue(after);
            if (revenue && revenue.state !== after) {
              after = revenue.state;
              const labelFor = (address: string) =>
                sandboxPlayerLabel(address) ?? truncateAddress(address);
              const tickerFor = (companyId: number) =>
                after?.public_companies.find((entry) => entry.company_id === companyId)?.ticker ??
                `company #${companyId}`;
              for (const payout of revenue.payouts) {
                logInfo("Private Revenue", describePrivatePayout(payout, labelFor, tickerFor));
              }
            }
          }
        }

        /* Design note #272/#273: the market atom, advanced BEFORE the game
           state because the game state needs the price it reports. Same
           contract as the waterfall's: this returns the figure rather than
           reaching into wallets, so one number is charged and logged. */
        const marketResult = applySandboxMarketAction(sandboxMarketRef.current, msg, {
          projectSale: (from, blocks) => projectShareSaleMove(from, blocks),
          // Design note #291: the dividend decision moves the marker too.
          projectDividend: (from, choice) => projectDividendCellMove(from, choice),
        });
        if (marketResult.prices !== sandboxMarketRef.current) {
          sandboxMarketRef.current = marketResult.prices;
          setSandboxMarket(marketResult.prices);
        }
        if (marketResult.moved) {
          const { companyId, from, to, reason } = marketResult.moved;
          const ticker =
            before?.public_companies.find((entry) => entry.company_id === companyId)?.ticker ??
            `#${companyId}`;
          /* Design note #435: says what actually moved it. This read "fell
             from $X to $Y on the sale" for EVERY move, so a withheld
             dividend -- the most common way a price falls in 1830, and the
             one a new president is most confused by -- was reported as a
             share sale that never happened. The direction is derived too:
             a payout RISES, and "fell" was wrong for it in the same
             sentence. */
          const [verb, cause] =
            reason === "payout"
              ? (["rose", "on the dividend payout"] as const)
              : reason === "withhold"
                ? (["fell", "on the withheld dividend"] as const)
                : (["fell", "on the share sale"] as const);
          logInfo("Market Move", `${ticker} ${verb} from $${from} to $${to} ${cause}.`);
        }

        if (after) {
          after = applySandboxAction(after, msg, {
            // Only `RunManualRoute` reads this, to total the printed value of
            // the stops the player picked instead of paying a flat nominal
            // for every route regardless of length.
            mapGrid,
            // Design note #492a: likewise read only by `RunManualRoute`.
            resetRouteRevenue: options?.resetRouteRevenue ?? false,
            era: ERA_FOR_PHASE_TINT[currentPhase?.tint ?? "yellow"],
            // Design note #273: what the chart says this share is worth, so
            // the wallet and the market agree about one trade.
            sharePrice: marketResult.tradePrice ?? undefined,
            /* Design note #411: the Operating Round queue is ordered by
               market price, and the chart is a separate atom the reducer
               must not reach into. Read from the REF, which the block above
               has just refreshed, so the order reflects any move this very
               dispatch caused rather than the previous render's prices. */
            marketPriceFor: marketPriceForCompany,
            /* Design note #351: the par ladder's selection, for the
               founding purchase that sets it. Read from the ref rather
               than the state variable for design note #265's reason --
               within one dispatch the state may still be a render behind,
               and a par set from a stale selection would be the wrong
               price forever.

               Design note #398: and read for THE COMPANY IN THIS MESSAGE.
               There is no longer a single "the par ladder's selection" to
               read -- asking for one was the bug. The protocol id comes off
               `msg` rather than from any ambient selection, because the
               message is the only thing that knows which company this
               particular dispatch is about. */
            parValue: parValueNumberFor(buyStockProtocolId(msg)) ?? undefined,
            /* Design note #363: the board's own label -> (q, r) table, so a
               corporation that floats gets its home token on the hex the
               map actually draws rather than on a coordinate this reducer
               guessed. */
            homeHexToAxial,
          });
          /* ==============================================================
           *  DESIGN NOTE 400: A FLOAT IS AN EVENT, NOT JUST A FLAG
           * ==============================================================
           *
           * REPORTED: when a company like ERIE floats, the UI completely
           * skips the home token placement -- no feedback that it happened.
           *
           * It did happen: `applyFloatThreshold` sets `is_floated`, credits
           * ten times par, and pushes the home hex onto
           * `station_token_hexes` (design note #363). All of it silently.
           * The player crossed 60% sold, the board gained a token, and
           * nothing said so -- so the one placement in the game that the
           * player does not perform reads as a placement that did not
           * occur.
           *
           * THE RULES FIX THE DESTINATION, so this is not made into a
           * choice. 1830 puts the home token on the home hex; offering a
           * picker would invent a decision and then refuse every answer but
           * one. What was missing is the REPORT, not the interaction.
           *
           * DIFFED HERE RATHER THAN REPORTED BY THE REDUCER, for design
           * note #337's reason: the reducer holds the game document and the
           * shell owns the log. Threading an event list out through
           * `applySandboxAction` -- which floats companies several frames
           * deep inside a share purchase -- would put a logging concern
           * into a pure function's return type.
           *
           * Naming the HEX is the point of the message. "ERIE floated" is a
           * state change; "ERIE floated and placed its home token on E11"
           * is the same change with the thing the player would otherwise go
           * looking for on the map. */
          /* Design note #401: a par sets a price, and a price is a cell on
             the chart. Diffed here beside the float announcement, and for
             the same reason -- the market atom is separate state, so the
             shell is what can write to both. */
          if (before) {
            for (const company of after.public_companies) {
              const wasUnparred =
                before.public_companies.find((e) => e.company_id === company.company_id)
                  ?.par_value ?? null;
              const wasFloated =
                before.public_companies.find((e) => e.company_id === company.company_id)
                  ?.is_floated ?? false;
              /* ==============================================================
               *  DESIGN NOTE 468: FLOATING IS ALSO A MOMENT TO CHECK
               * ==============================================================
               *
               * REPORTED (critical): when the B&O floats in a Stock Round --
               * having parred back in the Auction -- its token never reaches
               * the market matrix, and the Operating Round queue that sorts
               * on market price then breaks the round transition.
               *
               * This diff watched ONE transition: `par_value` going from null
               * to set. That is the only moment a par is established for
               * seven of the eight corporations, because their par is set by
               * `BuyStock`, which dispatches through this path.
               *
               * The B&O's is not. Its par is set by answering the auction
               * prompt (design note #399), which writes state directly and
               * never passes through `runGameplayAction` -- so this diff
               * never saw the transition and no mark was ever created. The
               * Par Tray reads `par_value` off the game document and showed
               * the company; the matrix reads the market atom and had never
               * been told.
               *
               * SO THE INVARIANT IS ENFORCED AT FLOAT, not only at par. A
               * floated corporation must have a market position -- the
               * operating queue sorts on it and `sandboxMarketPositions`
               * draws from it -- and that has to hold no matter which code
               * path set the par. Checking it here catches the B&O and any
               * future path that sets a par without dispatching.
               *
               * IDEMPOTENT BY CONSTRUCTION. `placeParMark` returns the same
               * object when a mark already exists, so the ordinary case --
               * parred by `BuyStock`, marked by the branch above, floating
               * later -- passes through untouched and no token is ever
               * dragged back to par after walking. */
              const parredNow = wasUnparred === null && company.par_value !== null;
              const floatedNow = !wasFloated && company.is_floated;
              if ((parredNow || floatedNow) && company.par_value !== null) {
                const par = Number(company.par_value);
                /* Design note #415: `parBoxCellFor`, not `marketCellForPrice`. The
                   latter resolves a par to the chart's TOP ROW -- see its own
                   note -- which is what put five of the six par values on the
                   wrong cell. */
                setSandboxMarket((prices) => {
                  const next = placeParMark(prices, company.company_id, par, parBoxCellFor);
                  /* The REF too. `beginOperatingRound` reads prices through
                     `marketPriceForCompany`, which reads the ref -- and the
                     Stock Round close that opens the Operating Round runs in
                     this same dispatch, before React has committed the state.
                     Without this the queue would sort the newly-floated
                     company on a price the ref had not been told about yet. */
                  if (next !== prices) sandboxMarketRef.current = next;
                  return next;
                });
              }
            }
            for (const company of after.public_companies) {
              const previously = before.public_companies.find(
                (entry) => entry.company_id === company.company_id,
              );
              // Design note #400: the branching lives in `describeFloat`,
              // where a test can reach it.
              const line = previously ? describeFloat(previously, company) : null;
              if (line) logInfo("Float", line);
            }
          }

          sandboxStateRef.current = after;
          setSandboxState(after);

          /* ==============================================================
           *  DESIGN NOTE 353 (caller half): THE ROUND CHANGES HANDS
           * ==============================================================
           *
           * `recordPass` sets a one-shot flag when a full round of passes
           * closed the Stock Round. The shell consumes it here: it owns the
           * log, and it owns the round transition -- the reducer holds only
           * the game document and has no business deciding which tab the
           * player is looking at.
           *
           * The flag is CLEARED as it is read, so a later re-render cannot
           * fire the transition twice. */
          if (after.stock_round_just_ended) {
            const holder = after.player_addresses[after.priority_deal_index];
            const holderLabel = holder
              ? (sandboxPlayerLabel(holder) ?? truncateAddress(holder))
              : "the next player";
            logInfo(
              "Round",
              `Stock Round ends. Priority Deal shifts to ${holderLabel}.`,
            );
            /* ==========================================================
             *  DESIGN NOTE 411 (caller half): THE QUEUE IS BUILT HERE
             * ==========================================================
             *
             * This set `current_round_type` and `consecutive_passes` and
             * nothing else, so the Operating Round opened with whatever
             * `active_operating_order` the state already carried -- `[]`
             * for any game actually played into an OR rather than seeded
             * into one by a fixture. An OR with an empty queue cannot
             * advance and has no acting seat, which is both halves of the
             * reported infinite-round bug.
             *
             * `beginOperatingRound` is the same function the
             * `BeginOperatingRound` message arm uses, so the two entry
             * paths cannot build different queues -- or, as here, one of
             * them build none at all. */
            after = beginOperatingRound(after, marketPriceForCompany);
            after = { ...after, stock_round_just_ended: false };
            sandboxStateRef.current = after;
            setSandboxState(after);
            /* The tab follows the round. `surfaceTabFor` is the same lookup
               the round-transition effect uses, so the two cannot disagree
               about where an Operating Round is played. */
            setActiveMainTab(surfaceTabFor("OperatingRound"));
          }

          /* ==============================================================
           *  DESIGN NOTE 411 (caller half): AND THE ROUND HANDS BACK
           * ==============================================================
           *
           * The mirror of the block above. `advanceCorporation` raises this
           * when the last corporation in the queue has operated and the
           * sequence has no further Operating Round in it; the shell owns
           * the log and the tab, exactly as it does for the Stock Round's
           * close, so the reducer reports rather than navigates.
           *
           * Cleared as it is read for the same reason: a flag left standing
           * would re-fire the transition on the next render. */
          if (after.operating_round_just_ended) {
            logInfo(
              "Round",
              "Operating Round ends — every corporation has operated. Opening the next Stock Round.",
            );
            after = {
              ...after,
              operating_round_just_ended: false,
              current_round_type: "StockRound" as const,
              macro_round_number: after.macro_round_number + 1,
              sub_round_index: 0,
              consecutive_passes: 0,
              last_trader_index: null,
              // The Priority Deal holder opens the Stock Round -- the whole
              // point of holding it (design note #353).
              active_player_index: after.priority_deal_index,
            };
            sandboxStateRef.current = after;
            setSandboxState(after);
            setActiveMainTab(surfaceTabFor("StockRound"));
          }
        }

        // Design note #265: described against the RESOLVED state.
        label =
          describeGameplayAction(msg, { ...describeContext, afterState: after }) ?? label;

        setActionLog((log) => [
          {
            id,
            label,
            status: "success",
            detail: "Sandbox: applied to local mock state (nothing signed, no chain).",
            timestamp,
            timestampMs,
            // Design note #343: stamped at write time.
            round: roundLabelRef.current ?? undefined,
          },
          ...log,
        ]);
        return;
      }

      if (spectator) {
        setActionLog((log) => [
          {
            id,
            label,
            status: "info",
            detail: "Spectator mode — watching only. Join from the lobby to play.",
            timestamp,
            timestampMs,
            // Design note #343: stamped at write time.
            round: roundLabelRef.current ?? undefined,
          },
          ...log,
        ]);
        return;
      }

      setActionLog((log) => [
        {
          id,
          label,
          status: "pending",
          detail: "Broadcasting via session key...",
          timestamp,
          timestampMs,
          // Design note #343: stamped at write time. The `log.map` updaters
          // below only change `status`/`detail`, so the stamp survives the
          // pending -> success transition.
          round: roundLabelRef.current ?? undefined,
        },
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
        refreshGameState();
      } catch (e) {
        const message = e instanceof Error ? e.message : "Unknown error executing action.";
        setActionLog((log) =>
          log.map((entry) => (entry.id === id ? { ...entry, status: "error", detail: message } : entry)),
        );
      }
    },
    // `mapGrid`/`currentPhase` join the list because the sandbox branch now
    // reads both to price a route. Omitting them would close over the board
    // as it was when this callback was last built, so a route run after a
    // tile lay would be scored against the PRE-LAY map -- the exact stale
    // number the tester exists to make visible.
    // `orSubPhase` joins them for design note #178's undo snapshot, which
    // records the cursor alongside the state so an undone tile lay also
    // restores the step the turn was on.
    // `logInfo` joins for design note #261's auction, which announces a won
    // private. The seating order the auction reducer needs is no longer a
    // dependency: design note #265 reads it off `sandboxStateRef`, which is
    // current by construction rather than as-of the last render -- one of
    // the staleness classes the ref was introduced to close.
    [
      session,
      refreshGameState,
      spectator,
      sandbox,
      mapGrid,
      currentPhase,
      orSubPhase,
      logInfo,
      // Design note #262: the label is derived from live state, so a stale
      // closure here would name the corporation that WAS acting and quote
      // the price the chart HAD -- a log that is wrong in exactly the way
      // the old variant-name labels never could be.
      gameState,
      marketGrid.positions,
      /* Design note #398: the per-company par lookup. Stable (a `useCallback`
         with no deps, reading a ref) but listed anyway -- an omitted stable
         dependency is still a dependency, and the moment it stops being
         stable a silent staleness bug is exactly the kind this file has
         collected notes about. */
      parValueNumberFor,
      /* Design note #411: the market-price lookup for the Operating Round
         queue. Stable for the same reason and listed on the same principle
         as `parValueNumberFor` above -- both are `useCallback`s over a ref,
         and both would go stale silently if that ever changed. */
      marketPriceForCompany,
      // Design note #416: hoisted out of this object literal, so it is a
      // dependency now rather than a freshly-built closure each call.
      homeHexToAxial,
    ],
  );


  const handlePassTurn = useCallback(
    () => runGameplayAction("PassTurn", { PassTurn: { game_id: gameId } }),
    [runGameplayAction, gameId],
  );

  const handleUndoLastAction = useCallback(() => {
    // Design note #178: in sandbox, pop the snapshot stack. Online, dispatch
    // the real message and let the contract decide what undo means -- a
    // local restore there would put the UI out of step with the chain.
    if (sandbox) {
      setSandboxHistory((stack) => {
        /* ==============================================================
         *  DESIGN NOTE 439: UNDO REWINDS TO A DECISION, NOT TO A STEP
         * ==============================================================
         *
         * REPORTED: Undo after the game has auto-skipped a sub-phase drops
         * the player into the sub-phase that was skipped.
         *
         * It did, and the mechanism was faithful rather than broken: every
         * dispatch pushes a snapshot, and the auto-skip and forced-withhold
         * effects dispatch real messages. A turn that ran Track -> (skip
         * Tokens) -> (skip Routes) -> (withhold $0) left four snapshots on
         * the stack, three of them recording moves the player never made.
         * One Undo therefore landed on the Dividends step -- and landed
         * there STUCK, because `autoSkippedRef` had already recorded that
         * step as handled and would not skip it a second time.
         *
         * So Undo now rewinds to the last snapshot the PLAYER created and
         * discards the automatic ones stacked above it. One press returns
         * to the last thing they actually chose, which is what the button
         * has always claimed to do.
         *
         * THE AUTOMATIC STEPS RE-RUN, and that is the point rather than a
         * side effect. Restoring the pre-Track state also restores the
         * sub-phase cursor, and `autoSkippedRef`/`forcedWithholdRef` are
         * keyed by `(corporation, step)` -- so the guards still hold within
         * the turn and the skips reapply from whatever the player does
         * next. Undo puts the player back at the decision; the consequences
         * of that decision are recomputed rather than replayed.
         *
         * ALL-AUTOMATIC IS A REAL CASE. A corporation whose whole turn was
         * skipped has no player snapshot to return to, so the oldest entry
         * is used -- the start of what this stack remembers, which is the
         * furthest back Undo can honestly go. */
        const target = undoTargetIndex(stack);
        const previous = target === null ? undefined : stack[target];
        if (target === null || !previous) {
          logInfo("Undo", "Nothing to undo — this is the start of the scenario.");
          return stack;
        }
        const skipped = undoSkippedCount(stack);
        sandboxStateRef.current = previous.state;
        setSandboxState(previous.state);
        setMapGrid(previous.mapGrid);
        setOrSubPhase(previous.subPhase);
        /* Design note #310: the other three atoms, restored through their
           refs as well as their state so the very next dispatch reads the
           reverted values rather than the ones it just undid. Writing only
           the state would leave the refs holding the future. */
        sandboxWaterfallRef.current = previous.waterfall;
        setSandboxWaterfall(previous.waterfall);
        sandboxMarketRef.current = previous.market;
        setSandboxMarket(previous.market);
        settledPrivatePricesRef.current = previous.settledPrices;
        setSettledPrivatePrices(previous.settledPrices);
        // Any in-flight preview belonged to the state just discarded.
        setPreviewTile(null);
        setRadialSelector(null);
        /* ==============================================================
         *  DESIGN NOTE 475: THE AUTOMATIC CONSEQUENCES MUST BE FREE TO
         *  HAPPEN AGAIN
         * ==============================================================
         *
         * The auto-skip and forced-withhold effects each guard themselves
         * with a once-per-(corporation, step) key, so they fire once and
         * not on every render while a poll is in flight. Undo restores a
         * state those effects have already reacted to -- so without
         * clearing the guards, a player who undoes back past a skipped step
         * and then redoes their action arrives at a step that will not skip
         * itself a second time, and sits there with no control to advance.
         *
         * Clearing both is the completion of "Undo returns the player to
         * the decision; the game re-derives what followed". The guards exist
         * to stop repeat firing WITHIN a turn, not to record history, so
         * resetting them costs nothing and is what makes not-recording the
         * automatic actions safe. */
        autoSkippedRef.current = new Set();
        forcedWithholdRef.current = new Set();
        /* ==============================================================
         *  DESIGN NOTE 479 (cont.): NAME IT
         * ==============================================================
         *
         * "Reverted the last action" told a player nothing they did not
         * already know -- they had just pressed the button. What they need
         * confirmed is WHICH action, because by the time Undo is reached
         * for, the reason it was reached for is usually that the last
         * action was not the one they thought.
         *
         * The stored sentence is quoted with its subject removed when the
         * subject is the actor being named, so "PRR" and "PRR laid a
         * yellow tile on B12" collapse to "PRR reverted: laid a yellow tile
         * on B12" rather than saying PRR twice.
         *
         * A COLON RATHER THAN A RE-CONJUGATION. `[Actor] reverted [Action]`
         * cannot be built by concatenation -- the stored clause is past
         * tense ("laid a tile") and reads as a grammatical error directly
         * after another past-tense verb. The colon presents it as the thing
         * being quoted, which is what it is, and keeps one sentence in one
         * tense instead of rewriting every verb in `actionLog.ts` to have a
         * second form. */
        const revertedActor = previous.actor;
        const revertedClause = previous.label.startsWith(`${revertedActor} `)
          ? previous.label.slice(revertedActor.length + 1)
          : previous.label;
        const reverted = previous.label
          ? `${revertedActor} reverted: ${revertedClause}`
          : "Reverted the last action.";
        logInfo(
          "Undo",
          /* Design note #475: `skipped` should always be 0 now -- automatic
             actions do not enter the stack. A non-zero value means the
             safety net in `undoTargetIndex` caught an entry the dispatch
             path should not have pushed, and saying so beats reverting
             several steps silently. */
          skipped > 0
            ? `${reverted} (${skipped} automatic step${skipped === 1 ? "" : "s"} recorded in error were discarded too.)`
            : reverted,
        );
        return stack.slice(0, target);
      });
      return;
    }
    runGameplayAction("UndoLastAction", { UndoLastAction: { game_id: gameId } });
  }, [sandbox, runGameplayAction, gameId, logInfo]);

  // Design note (Stock & Auction pass): reads real UI-driven selection state
  // from `StockRoundPanel` (`srSelectedProtocolId`/`srSource`/`srParValue`)
  // instead of the old hardcoded `MOCK_BUY_STOCK_*` constants -- see
  // `StockRoundPanel.tsx` design note #2. `par_value` becomes `null`
  // whenever the selected company is already floated, since a floated
  // company's price comes from the Stock Market Matrix, not a fresh par
  // choice (matches `BuyStock`'s own real semantics, not a fabricated one).
  /* ---- Design note #29: THE TARGET COMPANY IS AN ARGUMENT ------------
   *
   * Both handlers used to read `srSelectedProtocolId` -- a single "which
   * company is selected" value, which was correct while the Stock Round had
   * exactly one set of controls fed by a pill selector.
   *
   * Permanently expanding the corporation cards breaks that assumption
   * completely: there are now EIGHT live Buy buttons and eight live Sell
   * buttons on screen at once. Reading a shared selection would mean every
   * one of them dispatched against whichever company happened to be
   * selected -- so clicking Buy inside the B&M card would buy PRR. Silently,
   * with a perfectly successful transaction, and no way to tell from the UI
   * that anything had gone wrong until the roster refreshed.
   *
   * Setting the selection on click and then dispatching does NOT fix it:
   * `setState` is asynchronous, so the handler would still read the
   * previous value on the click that mattered.
   *
   * So the company id is a parameter. There is no shared selection left to
   * go stale, and the id travels with the click that produced it. */
  /* ==================================================================
   *  DESIGN NOTE 42: MULTI-BUY IS N TRANSACTIONS, NOT A BATCH
   * ==================================================================
   *
   * The Brown zone lets a player take several bank-pool shares in one turn
   * (`StockRoundPanel.tsx` design note #33). `ExecuteMsg::BuyStock` has no
   * quantity parameter, so "buy 3" is three sequential `BuyStock` messages.
   *
   * SEQUENTIAL, AND STOPPING AT THE FIRST FAILURE. `runGameplayAction`
   * awaits each broadcast, so purchase N+1 is only attempted once N has
   * been accepted on chain. Firing them in parallel would race the
   * contract's own pool accounting and could leave the player having bought
   * fewer shares than the log claims. Each purchase is its own log entry,
   * which is accurate rather than noisy -- it really is three purchases.
   *
   * A batched `BuyStock { quantity }` would make this one signature and one
   * atomic state change, and is worth raising in the contract audit. Until
   * then this is the honest shape of the operation, not a workaround
   * pretending to be atomic. */
  const buyOneShare = useCallback(
    (protocolId: number, source: "Ipo" | "Bank") => {
      const isFloated =
        gameState?.public_companies.find((c) => c.company_id === protocolId)?.is_floated ?? false;
      return runGameplayAction(
        "BuyStock",
        {
          BuyStock: {
            game_id: gameId,
            protocol_id: protocolId,
            // Design note #18 in `StockRoundPanel.tsx`: the buy source is
            // per-card state now, so it arrives as an argument rather than
            // being read from a shared value that every card could flip.
            source,
            // A floated company's price comes from the Stock Market Matrix,
            // not a fresh par choice -- matches `BuyStock`'s real semantics.
            // Resolved from the company being BOUGHT, not from a selection.
            // Design note #398: resolved from the company being BOUGHT,
            // which is now genuinely possible -- it used to say that and
            // then read a single shared value.
            par_value: isFloated ? null : parValueFor(protocolId),
          },
        },
      );
    },
    [runGameplayAction, gameId, gameState, parValueFor],
  );

  /* ==================================================================
   *  DESIGN NOTE 416: WHO STILL OWES A HOME STATION
   * ==================================================================
   *
   * Derived from the board every render rather than raised as a one-shot
   * flag when the float happens. `pendingHomeTokens` asks "is this floated
   * corporation's printed home hex empty", which stays true until it is
   * answered -- so a reload, a late poll, or two corporations floating on
   * one dispatch all resolve correctly, and a prompt cannot be lost.
   *
   * ONLY THE HEAD OF THE QUEUE is prompted. Several can float at once (a
   * waterfall cascade, or a multi-buy crossing two thresholds); they are
   * returned in operating order and the next appears as this one is
   * answered.
   *
   * NATURALLY INERT AGAINST A LIVE CHAIN, and worth stating because it
   * looks like a gap. The contract's `grant_home_station_token` places the
   * token as part of floating, so on a real game the hex is already
   * occupied by the time any state reaches this line and the list comes
   * back empty. This prompt governs the SANDBOX, which is the only place
   * the frontend owns the placement -- a frontend cannot decline to do
   * something the chain has already done. */
  const pendingHomeToken = useMemo(() => {
    if (!gameState) return null;
    const owed = pendingHomeTokens(gameState, homeHexToAxial)[0] ?? null;
    if (!owed) return null;

    /* ==================================================================
     *  DESIGN NOTE 440: THE PRESIDENT'S PROMPT, NOT EVERYONE'S
     * ==================================================================
     *
     * REPORTED: the home station prompt fires for all players.
     *
     * It did. `pendingHomeTokens` answers "which corporation owes a token",
     * which is a fact about the BOARD and therefore true for every viewer
     * at once -- so a modal keyed on it alone appeared on four screens,
     * three of them belonging to players with no right to answer it. Worse,
     * it is a BLOCKING modal with no dismissal (see the component's own
     * note on why that is correct for the president), so the other three
     * players were locked out of the game by a decision that was not
     * theirs.
     *
     * The presidency is already carried on the pending entry, so the gate
     * is a comparison rather than new plumbing.
     *
     * HOTSEAT KEEPS THE PROMPT, and that is why this tests the SEAT rather
     * than the wallet. At a shared keyboard `viewerAddress` is the seat
     * currently being played, which is exactly who should be answering --
     * gating on a connected wallet would silence the prompt for the one
     * mode where every seat is the viewer in turn. `sandboxSeatIndex`
     * drives `viewerAddress` there, so following the seat is following the
     * person holding the mouse.
     *
     * A CORPORATION WITH NO PRESIDENT ON RECORD prompts nobody. That state
     * is reachable through the B&O private before its par is set, and a
     * modal nobody can answer is the same lockout in a different costume --
     * `pendingHomeTokens` already excludes hexes it cannot resolve, and
     * this excludes presidencies it cannot attribute. */
    /* ==================================================================
     *  DESIGN NOTE 455: THE FLOAT DOES NOT WAIT FOR A TURN
     * ==================================================================
     *
     * REPORTED: the prompt waits until it is the President's active turn to
     * appear.
     *
     * It did, and design note #441's gate was not the cause -- comparing
     * against `viewerAddress` is correct online, where that value is the
     * connected wallet and does not move. In HOTSEAT it moves: sandbox
     * derives `viewerAddress` from `sandboxSeatIndex`, and the Auto-Follow
     * effect walks that pointer to whoever is acting. So the president
     * became "the viewer" only when the turn reached them, and a float
     * triggered by ANOTHER player's purchase sat waiting for a turn that
     * might be three seats away.
     *
     * A float is not a turn action. It is a threshold crossing caused by
     * whoever bought the 60th percent -- frequently not the president at
     * all -- and 1830 resolves it immediately, before play continues. So
     * the prompt fires on the FACT, not on the cursor.
     *
     * HOTSEAT ANSWERS FOR THE PRESIDENT, WHOEVER IS SEATED. One keyboard,
     * one screen: the person at it is every seat in turn, so requiring the
     * seat pointer to have arrived at the president is requiring a
     * formality that has no counterpart in the physical game -- where the
     * president simply reaches over and places their token. `hotseatSeat`
     * below is that reading, and it is scoped to sandbox so an online
     * client still shows this to exactly one player.
     *
     * THE SEAT FOLLOWS THE PROMPT, not the other way round. When the
     * prompt fires for a president who is not the seated player, the
     * accompanying effect moves the seat to them -- so the map flow that
     * follows (design note #440) acts as the right corporation rather than
     * as whoever happened to be up. Without that the placement would be
     * attributed to the wrong seat's view. */
    /* ==================================================================
     *  DESIGN NOTE 460: THE SEAT SYNC HAS TO LAND FIRST
     * ==================================================================
     *
     * REPORTED: the modal pops up for the player who bought the floating
     * share rather than waiting for the President.
     *
     * Design note #455 fixed the opposite complaint -- the prompt waiting
     * for the president's TURN -- and over-corrected. Its `hotseatSeat`
     * escape hatch rendered the modal for whoever was seated the moment a
     * corporation floated, on the reasoning that one keyboard means the
     * person at it is every seat in turn. True of a turn; false of this
     * instant. The float is caused by whoever bought the 60th percent, and
     * that buyer is very often NOT the president -- so the modal appeared
     * over the buyer's screen, addressed to somebody else, asking them to
     * place a token they do not own.
     *
     * Both notes wanted the same thing and #455 reached for it one step too
     * early. The prompt should fire IMMEDIATELY -- not wait for a turn --
     * and it should fire FOR THE PRESIDENT. Those are compatible: the seat
     * effect below moves the hotseat cursor to the president as soon as a
     * token is owed, and this gate simply waits for that move to land.
     *
     * SO THE TEST IS STRICT IDENTITY, in hotseat and online alike. One
     * render's delay while the seat syncs is the entire cost, and it buys a
     * modal that is never addressed to the wrong person. `sandbox` no
     * longer appears in this condition at all, which is the tell that the
     * special case is gone rather than narrowed. */
    if (!owed.president || owed.president !== viewerAddress) return null;
    return owed;
  }, [gameState, homeHexToAxial, viewerAddress]);

  /** Design note #455: the seat index of the outstanding prompt's
   *  president, or `null` when there is no prompt or the right seat is
   *  already selected. Derived rather than computed inside the effect so
   *  the effect's dependency is a stable number and it cannot re-fire on
   *  every unrelated state change. */
  /** Design note #460: reads the RAW owed token, not `pendingHomeToken`.
   *
   *  `pendingHomeToken` is now gated on the viewer already being the
   *  president, so deriving the seat fix from it would be circular -- the
   *  seat would only move once it had already moved. This asks the board
   *  the same question without the identity filter: is a token owed, and
   *  whose president owes it.
   *
   *  `null` once the seat is right, which is what stops the effect below
   *  fighting Auto-Follow for the cursor every render. */
  const pendingHomeTokenSeatFix = useMemo(() => {
    if (!sandbox || !gameState) return null;
    const owed = pendingHomeTokens(gameState, homeHexToAxial)[0] ?? null;
    if (!owed?.president) return null;
    const seat = gameState.player_addresses.indexOf(owed.president);
    if (seat === -1 || seat === sandboxSeatIndex) return null;
    return seat;
  }, [sandbox, gameState, homeHexToAxial, sandboxSeatIndex]);

  /* Design note #455: seat the president the prompt is addressed to.
   *
   * Hotseat only -- online there is no seat pointer to move, and the prompt
   * is already on the right client. Runs when a prompt is outstanding and
   * the seated player is not its president, which is precisely the case the
   * old gate silently swallowed.
   *
   * It also switches Auto-Follow OFF for the duration in effect: the
   * follow effect would otherwise pull the seat straight back to the acting
   * corporation on the next render, and the two would fight. Restoring it
   * is not needed -- the follow effect re-runs on the next state change and
   * takes the seat back once the prompt is answered. */
  useEffect(() => {
    if (!sandbox || !pendingHomeTokenSeatFix) return;
    setSandboxSeatIndex(pendingHomeTokenSeatFix);
  }, [sandbox, pendingHomeTokenSeatFix]);

  /* ==================================================================
   *  DESIGN NOTE 440: THE HOME STATION IS PLACED ON THE MAP
   * ==================================================================
   *
   * REPORTED: the prompt auto-places the token without map interaction.
   *
   * `null` when no home placement is in flight. When the president accepts
   * the prompt this holds the corporation, the one legal hex, and the tab
   * they came FROM -- so the flow can put them back where they were rather
   * than stranding them on the map.
   *
   * WHY THE RETURN TAB IS CAPTURED RATHER THAN ASSUMED. A float can happen
   * during a Stock Round (a purchase crosses 60%) or in the auction (the
   * B&O private), so "back" is not a constant. Reading `activeMainTab` at
   * the moment of the click records where the player actually was, which is
   * the only honest answer -- the requirement says "the Stocks tab" because
   * that is where a float usually happens, not because it always does. */
  const [homeStationPlacement, setHomeStationPlacement] = useState<{
    /* ==============================================================
     *  DESIGN NOTE 444: ONE VEIL, THREE ERRANDS
     * ==============================================================
     *
     * Design note #440 built this for the home station. The D&H's two
     * powers need exactly the same thing -- send the player to the Rail
     * Map, black out every hex but one, arm the right cursor, and put them
     * back afterwards -- so they use it rather than growing a second
     * mechanism beside it.
     *
     * `kind` is what differs, and it differs in only two ways: which
     * cursor to arm, and what the click does.
     *
     *   `home-station`    free token, the corporation's printed home hex
     *   `private-station` free token, the D&H's F16
     *   `private-tile`    an ORDINARY tile lay, at the hex's real terrain
     *                     cost -- the click is NOT intercepted, it falls
     *                     through to the tile picker, and the veil is doing
     *                     all the work.
     *
     * That last one is why `kind` is not simply a boolean "is this a
     * token". A tile lay through this flow is the normal lay path with the
     * board narrowed to one hex; anything else would be a second tile
     * pipeline to keep in step with the first. */
    kind: "home-station" | "private-station" | "private-tile";
    companyId: number;
    q: number;
    r: number;
    hexLabel: string;
    /** Design note #442: which action to mark spent once it lands. `null`
     *  for the home station, which is an obligation rather than a power. */
    abilityKey: string | null;
    returnTab: MainTab;
  } | null>(null);

  /** Design note #440: the single lit hex. Shaped exactly like
   *  `layTrackFocus`/`tokenTargetFocus` so it drops into the same `layFocus`
   *  prop -- one veil mechanism, three users, rather than a third way of
   *  dimming a board. */
  const homeStationFocus = useMemo(() => {
    if (!homeStationPlacement) return undefined;
    const only = new Set<string>([`${homeStationPlacement.q},${homeStationPlacement.r}`]);
    return {
      // `visible` and `highlighted` are the SAME single hex here, which is
      // the whole point: everything else on the board goes dark.
      visible: only,
      highlighted: only,
      glowColor: glowColorFor(stationTickerColor(homeStationPlacement.companyId)),
    };
  }, [homeStationPlacement]);

  /** Design note #416: the prompt's answer. Free -- this deliberately does
   *  NOT dispatch `PlaceStationToken`, which charges the escalating token
   *  price (design note #239). A home station costs nothing, and routing it
   *  through the paid message would bill a corporation for the one token
   *  1830 gives it. */
  /** Design note #440: the prompt's answer ARMS THE MAP. It no longer
   *  places anything -- it records where the player was, sends them to the
   *  Rail Map with the board veiled to one hex and the station cursor live,
   *  and waits for the click. `handleStageFreeStation` below stages that
   *  click, and `commitFreeStationPlacement` puts the token down once the
   *  confirmation ring is answered (design note #454). */
  const handlePlaceHomeStation = useCallback(
    (companyId: number, q: number, r: number) => {
      setHomeStationPlacement({
        kind: "home-station",
        companyId,
        q,
        r,
        hexLabel:
          STATIC_BOARD_HEXES.find((hex) => hex.q === q && hex.r === r)?.label ?? "its home hex",
        abilityKey: null,
        returnTab: activeMainTab,
      });
      setActiveMainTab("map");
      const ticker =
        gameState?.public_companies.find((entry) => entry.company_id === companyId)?.ticker ??
        `#${companyId}`;
      logInfo(
        "Home Station",
        `Click the lit hex on the Rail Map to place the ${ticker} home station.`,
      );
    },
    [gameState, activeMainTab, logInfo],
  );

  /** Design note #440: the board click that finishes it.
   *
   *  Free -- this deliberately does NOT dispatch `PlaceStationToken`, which
   *  charges the escalating token price (design note #239). A home station
   *  costs nothing, and routing it through the paid message would bill a
   *  corporation for the one token 1830 gives it. */
  /* Design note #454: the board click STAGES a free placement; it no longer
     performs one. `RadialTokenConfirm` then asks, and
     `commitFreeStationPlacement` below is what the check actually runs.

     This is the same STAGE-then-CONFIRM shape design note #201 gave the
     paid placement, arriving late for the two free ones -- and the reason
     it matters more here, not less: a home station is permanent, free, and
     the first piece a corporation ever puts on the board. An accidental
     click placing it instantly is not recoverable through the ordinary
     flow. */
  const handleStageFreeStation = useCallback(
    ({
      q,
      r,
      hexLabel,
      cityIndex,
      centroidX,
      centroidY,
      // Design note #516: the chosen city slot's own point.
      nodeX,
      nodeY,
    }: {
      q: number;
      r: number;
      hexLabel: string;
      cityIndex: number | null;
      centroidX: number;
      centroidY: number;
      /** Design note #516: the chosen city slot's centre, already through
       *  the board's live transform. Falls back to the centroid when the hex
       *  has no resolvable node. */
      nodeX: number;
      nodeY: number;
    }) => {
      const placement = homeStationPlacement;
      if (!placement) return;
      /* The veil already refuses every other hex (`layFocus.highlighted` is
         a one-element set), so this is a second lock on the same door --
         cheap, and the kind of guard that matters if the veil is ever
         loosened for a reason unrelated to this flow. */
      if (q !== placement.q || r !== placement.r) return;
      // Design note #444: a tile lay is not staged here. It falls through
      // to the tile picker and finishes in `handleConfirmRadialLay`.
      if (placement.kind === "private-tile") return;

      setPendingToken({
        q,
        r,
        hexLabel,
        cityIndex,
        kind: "free",
        /* Design note #516: the NODE, not the hex centre. On a dual-city
           home hex (ERIE's) or any OO tile the two are different points,
           and the ring belongs on the slot the token will occupy. */
        offsetX: nodeX,
        offsetY: nodeY,
      });
    },
    [homeStationPlacement],
  );

  /** Design note #454: what the confirmation ring runs for a free
   *  placement.
   *
   *  Free -- this deliberately does NOT dispatch `PlaceStationToken`, which
   *  charges the escalating token price (design note #239). A home station
   *  costs nothing, and routing it through the paid message would bill a
   *  corporation for the one token 1830 gives it. */
  const commitFreeStationPlacement = useCallback(
    ({ q, r }: { q: number; r: number }) => {
      const placement = homeStationPlacement;
      if (!placement) return;

      const ticker =
        gameState?.public_companies.find((e) => e.company_id === placement.companyId)?.ticker ??
        `#${placement.companyId}`;
      setSandboxState((current) => {
        if (!current) return current;
        const placed = placeHomeStationToken(current, placement.companyId, q, r);
        if (placed === current) return current;
        sandboxStateRef.current = placed;
        return placed;
      });
      logInfo(
        "Station Token",
        placement.kind === "home-station"
          ? `${ticker} places its home station token on ${placement.hexLabel}.`
          : `${ticker} places a free station token on ${placement.hexLabel} using the Delaware & Hudson.`,
      );
      if (placement.abilityKey) {
        setUsedPrivateAbilities((prev) => new Set(prev).add(placement.abilityKey as string));
      }
      setHomeStationPlacement(null);
      // Back where they came from -- see the state's own note on why this
      // is captured rather than hardcoded to the Stocks tab.
      setActiveMainTab(placement.returnTab);
    },
    [homeStationPlacement, gameState, logInfo],
  );

  /* Design note #399: the prompt's answer. Grants the certificate AND sets
     the price in one reducer call, so the intermediate state -- presided
     over, unpriced -- never exists for a render to catch. */
  const handleConfirmBoPar = useCallback(
    (parValue: string) => {
      const winner = boParPrompt?.player;
      setBoParPrompt(null);
      if (!winner) return;

      /* ==============================================================
       *  DESIGN NOTE 461/468: THE MARK IS SET OUTSIDE THE UPDATER
       * ==============================================================
       *
       * A par set here does not pass through `runGameplayAction`, so the
       * diff that normally creates a market mark never sees it -- design
       * note #399 made this a prompt precisely because the auction has no
       * `ExecuteMsg` for it. The mark therefore has to be written here too.
       *
       * BUT NOT INSIDE `setSandboxState`'S UPDATER, which is where a first
       * cut put it. A state updater must be PURE: React may invoke it more
       * than once for a single update (it does so deliberately in StrictMode),
       * and calling another setter from inside one is a side effect in a
       * function contracted not to have any. `placeParMark` is idempotent so
       * the symptom would have been subtle rather than loud, which is worse
       * -- it would have looked correct until some unrelated render made it
       * run at a different moment.
       *
       * `sandboxStateRef` already carries the current state synchronously
       * (design note #265), so the grant can be computed here, both atoms
       * written from one place, and the updater left doing nothing but
       * returning a value.
       *
       * DESIGN NOTE 468 MAKES THIS A BELT-AND-BRACES. The float diff now
       * enforces "a floated corporation has a market position" regardless of
       * how its par was set, so the B&O would gain its token there even if
       * this line were removed. It stays because the token should appear
       * when the par is SET -- the Par Tray shows it from that moment, and
       * the matrix disagreeing with the tray for a whole Stock Round is the
       * bug this was reported as. */
      const current = sandboxStateRef.current;
      if (!current) return;
      const granted = grantBOPresidency(current, winner, parValue, BO_TICKER);
      if (granted === current) return;

      sandboxStateRef.current = granted;
      setSandboxState(granted);

      const par = Number(parValue);
      const bo = granted.public_companies.find((c) => c.ticker === BO_TICKER);
      if (bo && Number.isFinite(par) && par > 0) {
        const marked = placeParMark(sandboxMarketRef.current, bo.company_id, par, parBoxCellFor);
        if (marked !== sandboxMarketRef.current) {
          sandboxMarketRef.current = marked;
          setSandboxMarket(marked);
        }
      }

      logInfoRef.current?.(
        "B&O Presidency",
        `${sandboxPlayerLabel(winner) ?? truncateAddress(winner)} receives the B&O President's Certificate and pars it at $${parValue}.`,
      );
    },
    [boParPrompt],
  );

  const handleBuyShare = useCallback(
    async (protocolId: number, source: "Ipo" | "Bank", quantity = 1) => {
      const times = Math.max(1, Math.floor(quantity));
      for (let i = 0; i < times; i += 1) {
        await buyOneShare(protocolId, source);
      }
    },
    [buyOneShare],
  );

  const handleSellShares = useCallback(
    (protocolId: number, percentage: number) =>
      runGameplayAction(
        "SellStock",
        {
          SellStock: {
            game_id: gameId,
            protocol_id: protocolId,
            percentage,
          },
        },
      ),
    [runGameplayAction, gameId],
  );

  const handleRunTrains = useCallback(async () => {
    /* Design note #250: the same block on the dispatch path. Guarding only
       the builder would leave a route drafted before the last train was
       sold still declarable. */
    if (!ownsAnyTrain) {
      setRouteFeedback(NO_TRAIN_ROUTE_REASON);
      return;
    }

    /* ==================================================================
     *  DESIGN NOTE 275: ONE MESSAGE PER TRAIN
     * ==================================================================
     *
     * `RunManualRoute` carries ONE `path`, because it declares one train's
     * run -- so a corporation running three trains sends three messages.
     * That is the contract's shape and not a limitation to work around:
     * each route is validated on its own, and a rejected third route does
     * not undo two accepted ones.
     *
     * Awaited in sequence rather than fired in parallel. The sandbox
     * reducer is synchronous through a ref (design note #265) so the
     * ordering matters there, and on a live chain sequential signing is
     * what the wallet expects anyway -- `handleBuyTrainsFromBank` sends its
     * N purchases exactly this way.
     *
     * INVALID DRAFTS ARE SKIPPED, NOT REFUSED. The panel's total already
     * excludes them and says so; blocking the whole dispatch because one of
     * three routes ends on a town would make the good two hostage to the
     * bad one. */
    const runnable = trainDrafts.filter(
      (draft) =>
        draft.value !== null &&
        draft.value > 0 &&
        !draft.exceedsMaxDistance &&
        !draft.endsOffTerminus &&
        // Design note #474: and it must touch one of this corporation's
        // tokens. The one 1830 rule this filter did not express.
        draft.tokenBlockReason === null,
    );

    if (runnable.length === 0) {
      const drafted = trainDrafts.filter((draft) => draft.hexLabels.length > 0);
      if (drafted.length === 0) {
        setRouteFeedback(
          "Select at least two connected hexes on the Rail Map to declare a route.",
        );
        return;
      }
      /* Design note #256: the LAST stop, reported here rather than on click.
         Every intermediate click is momentarily the last one, so refusing
         plain track during the draw would make it impossible to cross any --
         but a route that ENDS on a connector is one the contract will refuse,
         and finding that out from a rejected transaction is the outcome this
         check exists to avoid. */
      /* Design note #474: reported before the terminus hint, because a
         tokenless route is wrong about WHERE it runs rather than about how
         it ends -- telling the player to extend it would send them further
         in the wrong direction. */
      const tokenless = drafted.find((draft) => draft.tokenBlockReason !== null);
      if (tokenless?.tokenBlockReason) {
        setRouteFeedback(tokenless.tokenBlockReason);
        return;
      }
      const offTerminus = drafted.find((draft) => draft.endsOffTerminus);
      if (offTerminus) {
        const last = offTerminus.hexLabels[offTerminus.hexLabels.length - 1];
        setRouteFeedback(
          `${last} cannot END a route. Routes finish at a city or a red off-board hex — click one to finish, or click ${last} again to step back.`,
        );
        return;
      }
      setRouteFeedback("No drafted route can run yet.");
      return;
    }

    let firstOfBatch = true;
    for (const draft of runnable) {
      const points = routeDraftsRef.current[draft.trainIndex] ?? [];
      if (points.length < 2) continue;
      // eslint-disable-next-line no-await-in-loop
      await runGameplayAction(
        "RunManualRoute",
        {
          RunManualRoute: {
            game_id: gameId,
            protocol_id: actingProtocolId,
            path: routePointsToWaypoints(points),
            // The dividend decision belongs to the Dividends sub-phase, which
            // is the very next step -- so the revenue is withheld into the
            // treasury here and paid out (or not) there. Declaring a payout
            // from the Routes step would make the separate Dividends buttons
            // meaningless.
            payout_strategy: "Withhold",
          },
        },
        /* Design note #492a: only the first message clears the running
           total; the rest add to it. Flagged HERE rather than inferred in
           the reducer because this loop is the only thing that knows where a
           turn's batch begins -- and it is set inside the loop rather than
           from the index, since a draft with fewer than two points is
           skipped above and would otherwise consume the flag without
           dispatching anything. */
        { resetRouteRevenue: firstOfBatch },
      );
      firstOfBatch = false;
    }

    /* Design note #492: the total actually committed, recorded from the very
       list that was just dispatched rather than recomputed from the drafts.
       Those are the same figures the planner panel priced and the same ones
       the loop above sent, so the number the Dividends step spends is the
       number the player watched being assembled.

       `runnable` has already excluded every invalid draft (too long, ending
       off a terminus, touching no token), so this cannot count a route that
       was never sent -- which is the failure the panel's own total note
       warns about. */
    const committedTotal = runnable.reduce((sum, draft) => sum + (draft.value ?? 0), 0);
    setCommittedRouteRevenue({ protocolId: actingProtocolId, total: committedTotal });

    // Design note #278: this corporation HAS run, so any revenue on it is
    // this turn's and the dividend choice is binding.
    setRoutesRunThisTurn({ protocolId: actingProtocolId, ran: true });

    // Design note #142: advance Routes -> Dividends once trains have run.
    // Optimistic, matching this file's existing convention (design note #4)
    // of not gating local UI sequencing on a chain round-trip -- and now
    // necessary rather than cosmetic, since running trains is the step that
    // produces the figure the Dividends phase decides about.
    setOrSubPhase("Dividends");
  }, [runGameplayAction, gameId, trainDrafts, actingProtocolId, ownsAnyTrain]);

  // Generalized over `distribute` (design note #10/item 2 -- Phase 3's
  // explicit "Pay Dividends" vs "Withhold Revenue" buttons are the same
  // real `DeclareDividends` message, differing only in this one field).
  // Both optimistically advance to Phase 4 ("Hardware") on click, matching
  // this file's existing convention (design note #4) of not gating local UI
  // state on live tx confirmation -- the Action Log entry above already
  // reports success/failure independently.
  /* ==================================================================
   *  DESIGN NOTE 198: THE DIVIDEND WAS ALWAYS THE SAME $180
   * ==================================================================
   *
   * `revenue_amount` was `MOCK_DECLARE_DIVIDENDS_REVENUE` -- a fixed
   * constant left over from before routes were wired -- so whatever a
   * corporation had actually just earned, it declared the mock figure. The
   * panel directly above the buttons showed the REAL revenue and its real
   * per-share split, and then the button sent a different number. Two
   * figures for one decision, three inches apart, and the one the player
   * could see was not the one that travelled.
   *
   * It now reads `last_route_revenue` off the corporation the action targets
   * -- the same field `dividendRevenue` renders from, so the panel and the
   * message cannot disagree. Read INSIDE the callback rather than closed
   * over from the derived value further down this component: that value is
   * declared after this callback, and naming it in a dependency array here
   * would evaluate it before its own initialiser had run. */
  /* Design note #439: `automatic` for the same reason the skip has it --
     the forced $0 withhold (design note #414) is the game acting, and Undo
     must rewind past it to whatever the player last chose. */
  const declareDividendsChoice = useCallback(
    (distribute: boolean, automatic = false) => {
      const corporation = gameState?.public_companies.find(
        (entry) => entry.company_id === actingProtocolId,
      );
      /* ==============================================================
       *  DESIGN NOTE 484c: A SKIPPED TURN DECLARES ZERO, NOT LAST TURN'S
       * ==============================================================
       *
       * This read `last_route_revenue` unconditionally. That field is the
       * corporation's LAST run, which for a corporation that skipped Routes
       * is a previous turn's figure -- so the forced $0 withhold could
       * dispatch `DeclareDividends` for a stale positive amount and move
       * real money into the treasury for a run that did not happen this
       * turn.
       *
       * Design note #278 already identified the field as unreliable for
       * exactly this reason and used the observation to hide the PAY
       * button. It never reached the amount, so the button was corrected
       * and the message was not. */
      /* Design note #492: and the SAME committed total the panel above is
         quoting. This is the pair design note #198 was written about -- the
         figure on screen and the figure in the message -- so both read one
         derivation. Without it a multi-train corporation would see its real
         total, click Pay, and dispatch the last train's revenue. */
      const revenue = dividendDeclaration({
        lastRouteRevenue: corporation?.last_route_revenue,
        skippedRoutes: skippedRoutesThisTurn,
        committedRevenue:
          committedRouteRevenueRef.current?.protocolId === actingProtocolId
            ? committedRouteRevenueRef.current.total
            : null,
      }).revenue;
      runGameplayAction(
        distribute
          ? `DeclareDividends: Pay $${revenue}`
          : `DeclareDividends: Withhold $${revenue}`,
        {
          DeclareDividends: {
            game_id: gameId,
            protocol_id: actingProtocolId,
            revenue_amount: String(revenue),
            distribute,
          },
        },
        { automatic },
      );
      setOrSubPhase("Hardware");
    },
    [runGameplayAction, gameId, actingProtocolId, gameState, skippedRoutesThisTurn],
  );
  /* All three take NO arguments, so an `onClick` handler's event object can
     never arrive where `distribute` or `automatic` is expected -- design
     note #439's hazard, avoided by construction rather than by care. */
  const handlePayDividends = useCallback(
    () => declareDividendsChoice(true),
    [declareDividendsChoice],
  );
  const handleWithholdRevenue = useCallback(
    () => declareDividendsChoice(false),
    [declareDividendsChoice],
  );
  /** The forced $0 withhold's entry point -- design note #439. */
  const withholdRevenueAutomatically = useCallback(
    () => declareDividendsChoice(false, true),
    [declareDividendsChoice],
  );

  /* ==================================================================
   *  DESIGN NOTE 204: QUANTITY IS N MESSAGES, NOT A BATCH
   * ==================================================================
   *
   * `ExecuteMsg::BuyHardwareFromPool` carries no quantity field, so "buy 2"
   * is two messages. Exactly the shape of `handleBuyShare`'s multi-buy
   * (design note #42) and for the same reasons: `runGameplayAction` awaits
   * each broadcast, so purchase N+1 is only attempted once N has been
   * accepted, and each is its own Action Log line because it really is a
   * separate purchase.
   *
   * SEQUENTIAL MATTERS MORE HERE THAN FOR SHARES. Buying the depot's last
   * train of a tier advances the phase and can rust an entire generation of
   * trains off the board. Firing a quantity in parallel would race that
   * transition -- the second purchase would be priced and validated against
   * a depot the first had not finished emptying.
   *
   * `tier` is taken for the log line only. The contract picks the model
   * itself (`hardware.rs` module doc comment #2, "No model selection"), and
   * the panel only ever offers the tier the depot's queue is already on, so
   * the two cannot disagree -- but naming it here would be inventing a
   * parameter the message does not have.
   */
  const handleBuyTrainsFromBank = useCallback(
    async (tier: string, quantity: number) => {
      const times = Math.max(1, Math.floor(quantity));
      const before = depotInventory(gameState).find((row) => row.tier === tier);

      for (let i = 0; i < times; i += 1) {
        await runGameplayAction(
          times > 1
            ? `BuyHardwareFromPool: ${tier}-train (${i + 1} of ${times})`
            : `BuyHardwareFromPool: ${tier}-train`,
          { BuyHardwareFromPool: { game_id: gameId, protocol_id: actingProtocolId } },
        );
      }

      /* Design note #262: ONE summary for a multi-train purchase.
         Each message is its own transaction and gets its own line, which is
         accurate -- but "bought a 3-train" three times in a row buries the
         thing the player actually did. This adds the aggregate above them:
         what it cost in total, and what the depot has left afterwards. Only
         when there is an aggregate to state; for a single train the per
         message line already says everything. */
      if (times > 1 && before) {
        const ticker =
          gameState?.public_companies.find((entry) => entry.company_id === actingProtocolId)
            ?.ticker ?? `Corporation #${actingProtocolId}`;
        const remaining =
          before.remaining === null
            ? "unlimited"
            : `${Math.max(0, before.remaining - times)}/${before.total}`;
        logInfo(
          "Trains Bought",
          `${ticker} bought ${countPhrase(times, `${tier}-train`)} for $${before.cost * times}. ` +
            `Remaining depot supply: ${remaining}.`,
        );
      }
    },
    [runGameplayAction, gameId, actingProtocolId, gameState, logInfo],
  );

  // Buy Private Company Action Tray -- design note #14. `protocol_id` uses
  // the same `MOCK_LAY_TILE_PROTOCOL_ID` stand-in every other OR action on
  // this bar already targets (design note #1); `price` is stringified for
  // the same big-int-safety reason every other `Uint128` field is.
  /** Raise a proposal. Dispatches NOTHING -- design note #166. The purchase
   *  message is sent only if the offer is accepted. */
  /* ==================================================================
   *  DESIGN NOTE 206: BUYING YOUR OWN PRIVATE NEEDS NOBODY'S PERMISSION
   * ==================================================================
   *
   * Every proposal opened the consent prompt, including the commonest one in
   * the game: a president selling a private company they personally own into
   * the corporation they run. There is exactly one person involved in that
   * transaction and the app was asking them to agree with themselves --
   * a modal whose only possible answer is yes, in the middle of a turn.
   *
   * This is the same fork `train_trade.rs` already draws for trains
   * (design note #205): one party means settle now, two parties mean ask.
   * Applying it here makes the two flows behave alike, which matters because
   * they look alike.
   *
   * THE COMPARISON IS AGAINST THE BUYING CORPORATION'S PRESIDENT, not
   * against the viewer's wallet. The president is who the contract
   * authorises for `BuyPrivateCompany`, and in a hotseat sandbox the viewer
   * is whoever the seat switcher last selected -- so testing the viewer
   * would auto-complete or prompt depending on which seat happened to be on
   * screen, which is not a property of the trade at all.
   */
  const handleProposePrivatePurchase = useCallback(
    (privateId: number, price: number) => {
      const target = gameState?.private_companies.find((p) => p.private_id === privateId);
      if (!target || !target.owner) return;
      const buyer = gameState?.public_companies.find(
        (c) => c.company_id === actingProtocolId,
      );
      const buyerTicker = buyer?.ticker ?? `#${actingProtocolId}`;
      const ownerLabel = sandboxPlayerLabel(target.owner) ?? truncateAddress(target.owner);
      setPrivateTradeOpen(false);

      // The president of the buying corporation already owns it: one party,
      // nothing to negotiate, so the purchase completes outright.
      if (buyer?.president && buyer.president === target.owner) {
        runGameplayAction(`BuyPrivateCompany: ${target.name} @ $${price}`, {
          BuyPrivateCompany: {
            game_id: gameId,
            protocol_id: actingProtocolId,
            private_id: privateId,
            price: String(price),
          },
        });
        logInfo(
          "Buy Private Company",
          `${buyerTicker} bought ${target.name} from ${ownerLabel} for $${price} — its own President owned it, so it completed immediately.`,
        );
        return;
      }

      setPrivateProposal({
        privateId,
        privateName: target.name,
        ownerAddress: target.owner,
        ownerLabel,
        buyerProtocolId: actingProtocolId,
        buyerTicker,
        price,
      });
      logInfo(
        "Propose Purchase",
        `Offered $${price} for ${target.name}. Awaiting ${ownerLabel}'s answer.`,
      );
    },
    [gameState, logInfo, actingProtocolId, runGameplayAction, gameId],
  );

  /** Accepted. THIS is where the real message goes -- the one the contract
   *  has always had, now sent only after both sides have said yes (in
   *  sandbox) or after the buyer has confirmed knowing the seller was not
   *  asked (in a live room). */
  const handleAcceptPrivateOffer = useCallback(() => {
    if (!privateProposal) return;
    const { privateId, privateName, price, buyerProtocolId } = privateProposal;
    runGameplayAction(`BuyPrivateCompany: ${privateName} @ $${price}`, {
      BuyPrivateCompany: {
        game_id: gameId,
        protocol_id: buyerProtocolId,
        private_id: privateId,
        price: String(price),
      },
    });
    setPrivateProposal(null);
  }, [privateProposal, runGameplayAction, gameId]);

  const handleRejectPrivateOffer = useCallback(() => {
    if (!privateProposal) return;
    logInfo(
      "Offer Rejected",
      `${privateProposal.ownerLabel} declined $${privateProposal.price} for ${privateProposal.privateName}.`,
    );
    setPrivateProposal(null);
  }, [privateProposal, logInfo]);

  // Pre-Game Waterfall Auction Action Tray (`WaterfallAuctionDashboard.tsx`)
  // -- five real `ExecuteMsg` dispatches, `waterfall.rs`'s own five turn
  // actions exactly. `bid_amount`/`price` are stringified for the same
  // big-int-safety reason every other `Uint128` field in this file is.
  const handleWaterfallBuyLowest = useCallback(
    () => runGameplayAction("WaterfallBuyLowest", { WaterfallBuyLowest: { game_id: gameId } }),
    [runGameplayAction, gameId],
  );

  const handleWaterfallBidHigher = useCallback(
    (privateId: number, bidAmountVgp: number) =>
      runGameplayAction(`WaterfallBidHigher: private #${privateId} @ $${bidAmountVgp}`, {
        WaterfallBidHigher: {
          game_id: gameId,
          private_id: privateId,
          bid_amount: String(bidAmountVgp),
        },
      }),
    [runGameplayAction, gameId],
  );

  const handleWaterfallPass = useCallback(
    () => runGameplayAction("WaterfallPass", { WaterfallPass: { game_id: gameId } }),
    [runGameplayAction, gameId],
  );

  const handleWaterfallMiniAuctionRaise = useCallback(
    (bidAmountVgp: number) =>
      runGameplayAction(`WaterfallMiniAuctionRaise: $${bidAmountVgp}`, {
        WaterfallMiniAuctionRaise: { game_id: gameId, bid_amount: String(bidAmountVgp) },
      }),
    [runGameplayAction, gameId],
  );

  const handleWaterfallMiniAuctionPass = useCallback(
    () =>
      runGameplayAction("WaterfallMiniAuctionPass", {
        WaterfallMiniAuctionPass: { game_id: gameId },
      }),
    [runGameplayAction, gameId],
  );

  // Deliberately non-dispatching -- see design note #8 for why "Place
  // Station Token" has no single-button ExecuteMsg of its own.
  // Design note #159: this was a HINT -- it logged a line telling the player
  // to click a hex, and the hex click opened the tile picker, which lays
  // track and has nothing to do with tokens. There was no way to place a
  // token from this UI at all.
  //
  // It is now a real mode toggle. Turning it on disarms the tile picker and
  // points the next board click at `handleTokenHexClick` below.
  const handlePlaceStationTokenHint = useCallback(() => {
    setTokenTargetMode((current) => {
      const next = !current;
      logInfo(
        "Place Station Token",
        next
          ? "Targeting mode ON — click a city hex on the Rail Map to place the token. Click the button again to cancel."
          : "Targeting mode cancelled.",
      );
      return next;
    });
  }, [logInfo]);

  /** A board click while token targeting is on. Takes the same
   *  `{ q, r, hexLabel, clientX, clientY }` info object `onHexClick` hands
   *  every consumer, so it drops into the same slot `handleRouteHexClick`
   *  already occupies. */
  const handleTokenHexClick = useCallback(
    ({
      q,
      r,
      hexLabel,
      cityIndex,
      centroidX,
      centroidY,
      // Design note #516: the chosen city slot's own point.
      nodeX,
      nodeY,
    }: {
      q: number;
      r: number;
      hexLabel: string;
      cityIndex: number | null;
      centroidX: number;
      centroidY: number;
      /** Design note #516: the chosen city slot's centre, already through
       *  the board's live transform. Falls back to the centroid when the hex
       *  has no resolvable node. */
      nodeX: number;
      nodeY: number;
    }) => {
      /* ==================================================================
       *  DESIGN NOTE 238: THE THREE REFUSALS, BEFORE ANYTHING IS SIGNED
       * ==================================================================
       *
       * This checked only `isTokenableHex` -- "does this hex have a city" --
       * so a token could be staged on a city the corporation's track does
       * not reach, on one whose slots are already full, and on another
       * company's reserved home. All three are refused on chain, but only
       * after a signature, and the error that came back named a contract
       * variant rather than the situation.
       *
       * `evaluateStationPlacement` applies the same three rules here and
       * returns the sentence explaining which one bit. Its own design note
       * #2 is explicit about what it does NOT claim to judge, so the
       * contract remains the authority rather than gaining a rival. */
      const placement = activeStationCompany
        ? evaluateStationPlacement({
            mapGrid,
            q,
            r,
            company: activeStationCompany,
            allCompanies: gameState?.public_companies ?? [],
          })
        : { allowed: isTokenableHex(mapGrid, q, r), reason: null };

      if (!placement.allowed) {
        setRouteFeedback(
          placement.reason ??
            `${hexLabel} has no city to place a token in. Pick a city hex, or lay a city tile there first.`,
        );
        return;
      }
      setRouteFeedback(null);
      // Design note #201: STAGE, do not place. Targeting mode stays on, so a
      // click on another city re-aims rather than being swallowed by an open
      // confirmation for a hex the player has changed their mind about.
      // Design note #453: the node travels with the stage, so the
      // confirmation dispatches the city the player actually clicked.
      setPendingToken({
        q,
        r,
        hexLabel,
        cityIndex,
        kind: "paid",
        // Design note #516: the node's own point -- see the free placement.
        offsetX: nodeX,
        offsetY: nodeY,
      });
    },
    [mapGrid, activeStationCompany, gameState],
  );

  /** The green check. THIS is where the token is placed and the treasury
   *  charged -- design note #201. */
  const handleConfirmTokenPlacement = useCallback(() => {
    if (!pendingToken) return;
    const { q, r, cityIndex, kind } = pendingToken;
    setPendingToken(null);

    /* Design note #454: a FREE placement -- the home station or the D&H's
       F16 token -- finishes through its own committer. It must not reach
       `PlaceStationToken`, which charges the escalating price (design note
       #239): routing it there would bill a corporation for a token 1830
       gives it. */
    if (kind === "free") {
      commitFreeStationPlacement({ q, r });
      return;
    }

    setTokenTargetMode(false);
    // A corporation places at most one token per turn, so the Tokens step
    // is done -- the same "the action completes the step" rule the tile
    // lay follows. Routes is next in `OPERATING_SUB_PHASE_ORDER`.
    setOrSubPhase("Routes");
    runGameplayAction("PlaceStationToken", {
      PlaceStationToken: {
        game_id: gameId,
        protocol_id: actingProtocolId,
        q,
        r,
        /* Design note #453: OMITTED when the geometry could not tell which
           city was clicked. `sessionKey.ts` documents the absent key as
           "resolve the lowest-indexed city with a free slot" -- always a
           legal placement -- so omitting is the correct expression of "I do
           not know", and sending a guessed `0` would not be. */
        ...(cityIndex === null ? {} : { city_index: cityIndex }),
      },
    });
  }, [pendingToken, gameId, runGameplayAction, actingProtocolId, commitFreeStationPlacement]);

  /** The red X. Discards the staging and leaves targeting armed, so the
   *  player is back where they were rather than having to re-open the mode. */
  const handleCancelTokenPlacement = useCallback(() => {
    setPendingToken(null);
  }, []);

  // A staged placement must not outlive the mode that produced it -- the
  // same hazard design note #33 documents for the route toggle. Cleared
  // whenever targeting ends by any route (the Cancel banner, the sub-phase
  // advancing, the token being placed).
  useEffect(() => {
    if (!tokenTargetMode) setPendingToken(null);
  }, [tokenTargetMode]);

  // Leaving the Tokens step with targeting still on would leave the board
  // silently rewired -- the same hazard design note #33 documents for the
  // route toggle, and it is fixed the same way: the mode cannot outlive the
  // phase that offers it.
  useEffect(() => {
    if (orSubPhase !== "Tokens" && tokenTargetMode) setTokenTargetMode(false);
  }, [orSubPhase, tokenTargetMode, actingProtocolId]);

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
  /* Design note #179: ADVANCE HAS TO MOVE SOMETHING.
   *
   * This dispatched `AdvanceOperatingSubPhase` and stopped. Online that is
   * right -- the contract owns the cursor and the next poll reports the new
   * one. In sandbox there is no poll and no contract, so the message went
   * into the local reducer, which cannot help either: the sub-phase is
   * CLIENT-SIDE state (`orSubPhase`, this file), deliberately not on
   * `GameStateResponse`, so a reducer over that response has nothing to
   * step. The button dispatched, logged, and visibly did nothing.
   *
   * The cursor's owner moves it. `OPERATING_SUB_PHASE_ORDER` is the same
   * sequence the stepper renders, and `visibleSubPhases` drops `BuyPrivate`
   * before Phase 3 -- so advancing walks the steps the player can actually
   * see rather than a hidden one. */
  /* Design note #439: TWO ENTRY POINTS, ONE IMPLEMENTATION.
   *
   * The skip is dispatched both by the player (the Skip button) and by the
   * game (the auto-skip effect), and Undo has to tell them apart. A single
   * function taking `automatic = false` would be wrong in the dangerous
   * direction: `onClick={onSkipSubPhase}` hands React's MouseEvent in as the
   * first argument, and a truthy event would mark every MANUAL skip as
   * automatic -- so Undo would walk straight past the player's own choices.
   *
   * Two named callbacks make the caller state which it is, and neither can
   * be invoked with the wrong one by accident. */
  const skipSubPhase = useCallback((automatic: boolean) => {
    /* Design note #278: skipping Routes is the observation that makes a
       stale `last_route_revenue` harmless -- whatever the field says, this
       corporation did not run this turn, so there is nothing to allocate
       and Skip stays available on the Dividends step that follows. */
    if (orSubPhase === "Routes") {
      setRoutesRunThisTurn({ protocolId: actingProtocolId, ran: false });
    }
    runGameplayAction(
      "AdvanceOperatingSubPhase",
      {
        AdvanceOperatingSubPhase: {
          game_id: gameId,
          protocol_id: actingProtocolId,
        },
      },
      { automatic },
    );
    if (!sandbox) return;
    setOrSubPhase((current) => {
      // Design note #385: the same filtered list the strip renders, so Skip
      // walks past a hidden `Buy Private` rather than stopping on it.
      const steps = visibleSubPhases(
        gameState?.current_global_era,
        gameState?.private_companies,
      );
      const at = steps.indexOf(current);
      // Past the last step the turn is over, so hold rather than wrapping
      // back to Track -- wrapping would let a corporation lay a second tile.
      if (at < 0 || at >= steps.length - 1) return current;
      return steps[at + 1];
    });
  }, [runGameplayAction, gameId, actingProtocolId, sandbox, gameState, orSubPhase]);

  /** The Skip button. Safe to pass straight to `onClick` -- it takes no
   *  arguments, so an event object cannot be mistaken for a flag. */
  const handleSkipSubPhase = useCallback(() => skipSubPhase(false), [skipSubPhase]);
  /** The auto-skip effect's entry point -- design note #439. */
  const skipSubPhaseAutomatically = useCallback(() => skipSubPhase(true), [skipSubPhase]);

  // Audit G-15. Each refreshes the offer list on completion: the whole point
  // of these four is that they change what BOTH players can do next, and the
  // poll interval is too slow for an action the player just took themselves.
  const handleMakeTrainOffer = useCallback(
    (input: { sellerProtocolId: number; modelType: string; price: string }) => {
      runGameplayAction("BuyTrainFromCorporation", {
        BuyTrainFromCorporation: {
          game_id: gameId,
          buyer_protocol_id: actingProtocolId,
          seller_protocol_id: input.sellerProtocolId,
          model_type: input.modelType,
          price: input.price,
        },
      });
      refreshTrainOffers();
    },
    [runGameplayAction, gameId, refreshTrainOffers, actingProtocolId],
  );

  /** A train badge clicked and a price typed -- `TrainPurchasePanel`'s
   *  `onProposeTrade`.
   *
   *  THE FORK IS WHO HAS TO AGREE, and it is decided here rather than in the
   *  panel because only this file knows which deployment it is in:
   *
   *    SAME PRESIDENT -- one player controls both corporations, so there is
   *    nobody to ask. `train_trade.rs` settles this case on the spot and
   *    writes no offer, and the sandbox reducer's `BuyTrainFromCorporation`
   *    arm does the same, so dispatching immediately is correct in both.
   *
   *    DIFFERENT PRESIDENTS, ONLINE -- dispatch, and the contract records an
   *    offer the seller's own client will poll and answer. Real two-party
   *    consent, carried by the chain.
   *
   *    DIFFERENT PRESIDENTS, SANDBOX -- there is no chain to record it in,
   *    so the proposal is held locally and the prompt is shown. Accepting
   *    then sends the same `BuyTrainFromCorporation` the online path sends
   *    up front; rejecting sends nothing at all. Design note #205. */
  const handleProposeTrainTrade = useCallback(
    (proposal: TrainTradeProposal) => {
      const buyer = gameState?.public_companies.find(
        (entry) => entry.company_id === proposal.buyerProtocolId,
      );
      const samePresident =
        !!buyer?.president && buyer.president === proposal.sellerPresident;

      if (samePresident || !sandbox) {
        handleMakeTrainOffer({
          sellerProtocolId: proposal.sellerProtocolId,
          modelType: proposal.modelType,
          price: proposal.price,
        });
        logInfo(
          "Train Trade",
          samePresident
            ? `${proposal.buyerTicker} bought a ${proposal.modelType}-train from ${proposal.sellerTicker} for $${proposal.price} — same President, so it completed immediately.`
            : `${proposal.buyerTicker} offered $${proposal.price} to ${proposal.sellerTicker} for a ${proposal.modelType}-train. Awaiting ${proposal.sellerPresidentLabel}.`,
        );
        return;
      }

      setSandboxTrainProposal(proposal);
      logInfo(
        "Train Offer",
        `${proposal.buyerTicker} offered $${proposal.price} for one of ${proposal.sellerTicker}'s ${proposal.modelType}-trains. Awaiting ${proposal.sellerPresidentLabel}.`,
      );
    },
    [gameState, sandbox, handleMakeTrainOffer, logInfo],
  );

  /** Accepted in the sandbox. THIS is where the real message goes -- the one
   *  the contract has always had, sent only after both sides have said yes. */
  const handleAcceptSandboxTrainOffer = useCallback(() => {
    if (!sandboxTrainProposal) return;
    const proposal = sandboxTrainProposal;
    setSandboxTrainProposal(null);
    runGameplayAction(
      `BuyTrainFromCorporation: ${proposal.modelType}-train @ $${proposal.price}`,
      {
        BuyTrainFromCorporation: {
          game_id: gameId,
          buyer_protocol_id: proposal.buyerProtocolId,
          seller_protocol_id: proposal.sellerProtocolId,
          model_type: proposal.modelType,
          price: proposal.price,
        },
      },
    );
  }, [sandboxTrainProposal, runGameplayAction, gameId]);

  const handleRejectSandboxTrainOffer = useCallback(() => {
    if (!sandboxTrainProposal) return;
    logInfo(
      "Offer Rejected",
      `${sandboxTrainProposal.sellerPresidentLabel} declined $${sandboxTrainProposal.price} for ${sandboxTrainProposal.sellerTicker}'s ${sandboxTrainProposal.modelType}-train.`,
    );
    setSandboxTrainProposal(null);
  }, [sandboxTrainProposal, logInfo]);


  const handleAcceptTrainOffer = useCallback(
    (offerId: number) => {
      runGameplayAction("AcceptTrainOffer", {
        AcceptTrainOffer: { game_id: gameId, offer_id: offerId },
      });
      refreshTrainOffers();
    },
    [runGameplayAction, gameId, refreshTrainOffers],
  );

  const handleRejectTrainOffer = useCallback(
    (offerId: number) => {
      runGameplayAction("RejectTrainOffer", {
        RejectTrainOffer: { game_id: gameId, offer_id: offerId },
      });
      refreshTrainOffers();
    },
    [runGameplayAction, gameId, refreshTrainOffers],
  );

  const handleRescindTrainOffer = useCallback(
    (offerId: number) => {
      runGameplayAction("RescindTrainOffer", {
        RescindTrainOffer: { game_id: gameId, offer_id: offerId },
      });
      refreshTrainOffers();
    },
    [runGameplayAction, gameId, refreshTrainOffers],
  );

  /* ==================================================================
   *  DESIGN NOTE 218: THE COUNTERPARTY GETS THE SAME PROMPT ONLINE
   * ==================================================================
   *
   * The consent modal was sandbox-only, on the reasoning that a live room
   * does not need one: the contract records the offer and the seller's
   * president can answer it from `TrainTradePanel`'s pending-offer ledger.
   *
   * That is true about the MESSAGES and wrong about the interaction. The
   * ledger is a row in a panel that renders only during the Hardware
   * sub-phase, on the workspace tabs -- so the one player whose answer the
   * game is waiting on is also the player most likely not to be looking at
   * it. Meanwhile the BUYER's turn is blocked on that answer
   * (`operations::PendingTrainOfferBlocksTurn`), so an unnoticed row stalls
   * the table with no indication of why.
   *
   * A pending offer addressed to you is an interruption, and it should
   * interrupt. This derives the same `TrainTradePrompt` the sandbox shows
   * from the CHAIN's own offer register -- `GetTrainOffers`, already polled
   * -- whenever the viewer presides over the selling corporation. One
   * component, one affordance, two sources.
   *
   * WHAT DIFFERS FROM SANDBOX, and it is only the plumbing: accepting sends
   * the real `AcceptTrainOffer` and rejecting the real `RejectTrainOffer`,
   * both addressed by `offer_id`, rather than settling local state. The
   * ledger stays exactly as it was -- it still lists every offer in the room
   * including the ones this player is not party to, which the prompt
   * deliberately does not (design note #1 there: a pending offer is public
   * information, but only one person is being asked).
   *
   * ONE AT A TIME. `find` rather than a queue: `train_trade.rs` permits one
   * outstanding offer per buying corporation, and stacking prompts for
   * several sellers would be a modal pile-up for a state the contract makes
   * rare. The next offer surfaces when this one is answered.
   */
  /** Design note #233: the offers this viewer is party to -- as the seller
   *  who must answer, or as the buyer whose turn is held open by their own
   *  outstanding offer. Anything else in the room is somebody else's
   *  negotiation and does not warrant a panel on this player's buy screen.
   *
   *  IN SANDBOX EVERY OFFER QUALIFIES, for the same reason the consent
   *  prompt is answerable there by whoever is looking (`PrivateTradePanel`
   *  design note #2): one human drives every seat, so "offers addressed to
   *  me" is not a distinction that exists. */
  const viewerTrainOffers = useMemo(() => {
    if (sandbox) return trainOffers;
    if (!viewerAddress) return [];
    return trainOffers.filter(
      (offer) =>
        offer.seller_president === viewerAddress || offer.buyer_president === viewerAddress,
    );
  }, [sandbox, viewerAddress, trainOffers]);

  const liveTrainOffer = useMemo(() => {
    if (sandbox || !viewerAddress) return null;
    const offer = trainOffers.find((entry) => entry.seller_president === viewerAddress);
    if (!offer) return null;
    const tickerFor = (id: number) =>
      gameState?.public_companies.find((company) => company.company_id === id)?.ticker ?? `#${id}`;
    const proposal: TrainTradeProposal = {
      sellerProtocolId: offer.seller_protocol_id,
      sellerTicker: tickerFor(offer.seller_protocol_id),
      sellerPresident: offer.seller_president,
      sellerPresidentLabel:
        sandboxPlayerLabel(offer.seller_president ?? "") ??
        truncateAddress(offer.seller_president ?? ""),
      buyerProtocolId: offer.buyer_protocol_id,
      buyerTicker: tickerFor(offer.buyer_protocol_id),
      modelType: offer.model_type,
      price: offer.price,
    };
    return { offerId: offer.offer_id, proposal };
  }, [sandbox, viewerAddress, trainOffers, gameState]);

  const handleAcceptLiveTrainOffer = useCallback(() => {
    if (!liveTrainOffer) return;
    handleAcceptTrainOffer(liveTrainOffer.offerId);
  }, [liveTrainOffer, handleAcceptTrainOffer]);

  const handleRejectLiveTrainOffer = useCallback(() => {
    if (!liveTrainOffer) return;
    handleRejectTrainOffer(liveTrainOffer.offerId);
  }, [liveTrainOffer, handleRejectTrainOffer]);



  /* ==================================================================
   *  DESIGN NOTE 249: A STEP WITH NOTHING IN IT SHOULD NOT BE A CLICK
   * ==================================================================
   *
   * REPORTED: a corporation with no trains has to skip Run Routes and
   * Dividends by hand, and one at its train limit has to skip Buy Trains.
   *
   * Every Operating Round turn walks the same six steps, and for a great
   * many corporations three of them are foregone conclusions. A company that
   * owns no train cannot run a route, so it cannot have revenue, so it
   * cannot declare a dividend -- two steps whose only available action is
   * "move on". Early in an 1830 game most corporations are in exactly that
   * position for several rounds, which turns a turn into a sequence of
   * acknowledgements.
   *
   * WHY NOT HIDE THE STEPS INSTEAD. Because the contract's cursor still
   * walks them -- `or_phase::OR_PHASE_ORDER` is fixed, and a client that
   * jumped its display past a step the chain is still sitting on would
   * desync the bar from what the chain will accept (design note #144). The
   * cursor has to MOVE, which means dispatching the same
   * `AdvanceOperatingSubPhase` the Skip button sends. So the skip still
   * happens; it just happens without asking.
   *
   * FIRING ONCE IS THE WHOLE DIFFICULTY. Online, `handleSkipSubPhase` does
   * not move `orSubPhase` locally -- the cursor is poll-driven -- so a naive
   * effect would re-fire on every render until the next poll landed and
   * broadcast a transaction each time. The ref below records which
   * (corporation, step) pairs have already been auto-skipped, so each is
   * attempted exactly once however many times this re-renders.
   *
   * KEYED ON THE CORPORATION TOO, not just the step: the next company in the
   * queue reaches the same step needing its own decision, and a step-only
   * key would silently suppress it.
   */
  const atTrainLimitNow = useMemo(() => {
    const company = gameState?.public_companies.find(
      (entry) => entry.company_id === actingProtocolId,
    );
    const owned = company?.owned_trains?.length;
    // `undefined` means the chain does not report ownership. Skipping a step
    // on a guess would take the player's turn away from them, so an unknown
    // fleet is never treated as full.
    if (owned === undefined) return false;
    const limit = depot.find((tier) => tier.isCurrent)?.trainLimit;
    if (limit === undefined) return false;
    return owned >= limit;
  }, [gameState, actingProtocolId, depot]);

  /* ==================================================================
   *  DESIGN NOTE 414: A TRAIN IS NOT THE SAME THING AS A ROUTE
   * ==================================================================
   *
   * REPORTED: a corporation holding a train but with no legal route -- or
   * with routes that total $0 -- is still walked through Run Routes and is
   * still offered "Pay Dividends" on $0 at the step after.
   *
   * Design note #292 built the forced-withhold machinery and gated all of
   * it on `ownsAnyTrain`, which is the CHEAP half of the question. Owning a
   * train is necessary to run and nowhere near sufficient: a corporation
   * whose token sits on a city no track reaches, or whose only route runs
   * between two blank hexes, owns a train and can earn nothing with it. It
   * therefore passed every guard, arrived at Dividends with a live Pay
   * button quoting "$0 per share", and could pay a dividend of nothing --
   * which is not a legal 1830 declaration, and which left the share price
   * standing still when the rules move it left.
   *
   * THE PROBE IS THE DRAFTER, NOT A SECOND OPINION. `assignRouteSet` is the
   * same search the Auto Route button runs (design note #280), asked for
   * the same thing and read for its total rather than its paths. Writing a
   * cheaper "can this corporation reach anything" check would be a second
   * pathfinder to keep in step with the first, and the failure would be the
   * worst kind: a step skipped for a corporation that did have a route, or
   * a $0 dividend offered because the cheap check disagreed with the real
   * one about a junction.
   *
   * SCOPED TO THE TWO STEPS THAT ASK. The search is not free, so it runs
   * only during an Operating Round on Routes or Dividends, and only for a
   * corporation that owns a train at all -- `ownsAnyTrain` is still the
   * first question, it is just no longer the last one. Everywhere else this
   * is `null`, meaning "not asked", which the readers below distinguish
   * from a real `0`.
   *
   * `null` ALSO MEANS "COULD NOT TELL". A corporation with no tokens on the
   * board yet returns no assignments, and so would a board that has not
   * loaded. Both are reported as unknown rather than as zero, because the
   * consequence of a wrong zero here is an automatic, irreversible withhold
   * on a corporation that could have paid. */
  const maxRouteRevenue = useMemo<number | null>(() => {
    if ((gameState?.current_round_type ?? null) !== "OperatingRound") return null;
    if (orSubPhase !== "Routes" && orSubPhase !== "Dividends") return null;
    if (!ownsAnyTrain) return null;

    const corporation = gameState?.public_companies.find(
      (entry) => entry.company_id === actingProtocolId,
    );
    /* ==============================================================
     *  DESIGN NOTE 484a: NO TOKEN IS A FACT, NOT AN ABSENCE OF ONE
     * ============================================================== */
    if (!corporation) return null; // the chain has not answered at all.
    const startHexes = corporation.station_token_hexes ?? [];
    if (startHexes.length === 0) {
      /* This returned `null` -- unknown -- and the note above warns against
         a wrong zero. But a corporation the chain HAS reported, whose token
         list is an empty array, has nowhere for a route to start: that is
         not ignorance, it is the answer. Reporting it as unknown left the
         corporation stranded on Dividends with no auto-withhold, which is
         the very state the report describes.

         The distinction that keeps the warning honest is the one above:
         a corporation absent from the response is still `null`. */
      return corporation.station_token_hexes ? 0 : null;
    }

    const result = assignRouteSet({
      mapGrid,
      era: ERA_FOR_PHASE_TINT[currentPhase?.tint ?? "yellow"],
      startHexes,
      trains: ownedTrainRoster.map((train) => ({
        trainIndex: train.trainIndex,
        maxRevenueCentres: train.maxDistance ?? 4,
      })),
    });
    return result.totalRevenue;
  }, [
    gameState,
    orSubPhase,
    ownsAnyTrain,
    actingProtocolId,
    mapGrid,
    currentPhase,
    ownedTrainRoster,
  ]);

  /** Design note #414: whether this corporation can earn anything at all
   *  this turn. Owning no train and owning a stranded one are different
   *  facts with the same consequence, so they are answered together and the
   *  reason string keeps them distinguishable to the player. */
  const noEarnableRevenue = useMemo<string | null>(() => {
    if (!ownsAnyTrain) return "it owns no trains, so there is no route to run";
    if (maxRouteRevenue === 0) {
      return "its trains cannot reach a route that earns anything";
    }
    return null;
  }, [ownsAnyTrain, maxRouteRevenue]);

  /* ==================================================================
   *  DESIGN NOTE 438: WHY THIS CORPORATION CANNOT PLACE A STATION
   * ==================================================================
   *
   * `null` when it can. The three blocking conditions are checked in the
   * order a player would discover them -- do I have a token, can I pay for
   * it, is there anywhere to put it -- so the reason reported is the first
   * one that actually stops them rather than whichever is cheapest to test.
   *
   * THE TOPOLOGICAL CHECK IS THE REAL ONE, and it reuses
   * `placeableStationHexes`, which is the same set the targeting veil
   * lights (design note #240). A cheaper approximation -- "does the network
   * touch any city" -- would disagree with the veil about reservations,
   * occupied slots and OO tiles, and the failure would be the worst kind:
   * a step skipped for a corporation the map would have let place, or a
   * player held on a step whose veil lights nothing.
   *
   * SCOPED, because it walks every board hex. It runs only during an
   * Operating Round on the Tokens step; everywhere else this is `null`,
   * meaning "not asked". */
  const stationPlacementBlock = useMemo<string | null>(() => {
    if ((gameState?.current_round_type ?? null) !== "OperatingRound") return null;
    if (orSubPhase !== "Tokens") return null;
    /* Design note #438: the rule itself lives in `utils/stationTokens.ts`,
       beside `placeableStationHexes` which it consults and beside
       `evaluateStationPlacement` which decides what "placeable" means. A
       predicate about station legality that lived in the shell would be the
       fourth opinion on that question in three files. */
    return stationPlacementBlockReason({
      mapGrid,
      company: activeStationCompany,
      allCompanies: gameState?.public_companies ?? [],
      boardHexes: STATIC_BOARD_HEXES.map((hex) => [hex.q, hex.r] as const),
    });
  }, [gameState, orSubPhase, activeStationCompany, mapGrid]);

  /** Why this step has no decision in it, or `null` when it does. */
  const autoSkipReason = useMemo<string | null>(() => {
    if ((gameState?.current_round_type ?? null) !== "OperatingRound") return null;
    if (spectator) return null;
    if (orSubPhase === "Routes") {
      /* Design note #414: was `ownsAnyTrain ? null : ...`. A corporation
         with a train and no reachable revenue was held on a step whose only
         control drafts a route that cannot exist. */
      return noEarnableRevenue;
    }
    /* ==================================================================
     *  DESIGN NOTE 438: A STATION STEP WITH NOWHERE TO PLACE
     * ==================================================================
     *
     * REPORTED: players are forced to manually skip Place Station even when
     * they have no valid placements.
     *
     * The step held every corporation every turn, and for most of a game
     * most corporations cannot place at all: the allowance runs out, the
     * treasury is short, or the network reaches no city with a free slot.
     * Design notes #292 and #414 had already established that a step with
     * no decision in it should not be held on -- Routes and Dividends both
     * exit themselves -- and Tokens was simply never given the same
     * treatment.
     *
     * THREE REASONS, REPORTED SEPARATELY, because they call for different
     * responses from the player and the log line is the only place they
     * find out which one applied. Running out of tokens is permanent; being
     * short of cash is fixable next turn; having no reachable slot is a
     * fact about the map that a tile lay might change.
     *
     * `stationPlacementBlock` does the work -- see its own note for why the
     * topological check reuses `placeableStationHexes` rather than a
     * cheaper approximation. */
    if (orSubPhase === "Tokens") return stationPlacementBlock;
    /* ==================================================================
     *  DESIGN NOTE 292: A TRAINLESS DIVIDEND IS DECIDED, NOT SKIPPED
     * ==================================================================
     *
     * Dividends used to share the Routes reason and take the same exit --
     * `AdvanceOperatingSubPhase`, which moves the cursor and settles
     * nothing. For a corporation that ran no trains that is the wrong
     * exit, and design note #44 a few hundred lines below says why without
     * having connected the two: "every corporation moves LEFT on its first
     * turn, because it has no train yet and so cannot pay out". Skipping
     * meant it did not move at all, so the tutorial explained a market
     * lesson the board had not taught.
     *
     * 1830 has no third option here. Revenue of $0 is still revenue
     * declared, and withholding it is what a trainless corporation does --
     * which is the decision that steps the marker left. So the step
     * dispatches the real `DeclareDividends` rather than stepping past it.
     *
     * Handled below rather than through `autoSkipReason`, because the two
     * are different actions: one advances a cursor, the other declares. */
    /* Design note #414: `!ownsAnyTrain` became `noEarnableRevenue` for the
       same reason it did on Routes above -- a stranded train earns exactly
       what no train earns, and the step below settles both identically. */
    if (orSubPhase === "Dividends" && noEarnableRevenue !== null) return null;
    if (orSubPhase === "Hardware" && atTrainLimitNow) {
      return "it is already at its train limit";
    }
    return null;
  }, [gameState, spectator, orSubPhase, noEarnableRevenue, stationPlacementBlock, atTrainLimitNow]);

  /* Design note #292: the forced withhold. Same once-per-(corporation,step)
     guard as the auto-skip beside it, and for the same reason -- online the
     cursor is poll-driven, so an unguarded effect would broadcast a
     declaration on every render until the next poll landed.

     Design note #414: it now fires for a corporation that HAS a train and
     cannot earn with it, not only for one with no train at all. The
     declaration is identical either way -- $0, withheld, marker left -- so
     the two cases share this effect rather than growing a second one that
     would have to be kept in step with it. */
  const forcedWithholdRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if ((gameState?.current_round_type ?? null) !== "OperatingRound") return;
    if (spectator) return;
    if (orSubPhase !== "Dividends") return;
    /* ==============================================================
     *  DESIGN NOTE 484b: SKIPPING ROUTES SETTLES DIVIDENDS
     * ==============================================================
     *
     * `noEarnableRevenue` alone was the condition, and it is a PREDICTION:
     * it asks the pathfinder whether a route could have earned. Having
     * skipped Routes is an OBSERVATION -- the step is behind this
     * corporation and it ran nothing, whatever the pathfinder thinks it
     * might have managed.
     *
     * The observation has to be enough on its own, because the prediction
     * declines to answer in exactly the case the report is about (design
     * note #484). And it cannot contradict the rules: a corporation that
     * ran no trains has $0 to allocate, 1830 has no $0 dividend, so the
     * declaration is a withhold and the marker steps left. There is no
     * branch of the rule where this is a choice.
     *
     * MANUAL SKIPS TOO, deliberately. A player who declines to run a route
     * they could have run has still run nothing, and the market move is not
     * theirs to waive. */
    if (noEarnableRevenue === null && !skippedRoutesThisTurn) return;
    const key = `${actingProtocolId}:withhold`;
    if (forcedWithholdRef.current.has(key)) return;
    forcedWithholdRef.current.add(key);
    logInfo(
      "Auto-Withhold",
      `${
        skippedRoutesThisTurn
          ? "No routes were run"
          : ownsAnyTrain
            ? "No route earned anything"
            : "No trains ran"
      }, so there is nothing to pay out — $0 withheld and the share price steps left.`,
    );
    withholdRevenueAutomatically();
  }, [
    gameState,
    spectator,
    orSubPhase,
    noEarnableRevenue,
    skippedRoutesThisTurn,
    ownsAnyTrain,
    actingProtocolId,
    withholdRevenueAutomatically,
    logInfo,
  ]);

  const autoSkippedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!autoSkipReason) return;
    const key = `${actingProtocolId}:${orSubPhase}`;
    if (autoSkippedRef.current.has(key)) return;
    autoSkippedRef.current.add(key);
    logInfo(
      "Auto-Skip",
      `Skipped ${OPERATING_SUB_PHASE_LABELS[orSubPhase].stepLabel} — ${autoSkipReason}.`,
    );
    // Design note #439: the AUTOMATIC entry point, so Undo rewinds past it.
    skipSubPhaseAutomatically();
  }, [autoSkipReason, actingProtocolId, orSubPhase, skipSubPhaseAutomatically, logInfo]);

  // Phase 4 -> ends the corporation's turn via the SAME real `PassTurn`
  // dispatch the Stock Round's "Pass Turn" button uses (per `msg.rs`'s own
  // doc comment, `PassTurn` is the one message that advances an Operating
  // Round to the next corporation too -- not a separate ExecuteMsg), then
  // resets the local phase back to "Track" for whichever corporation goes
  // next (the poll-driven reset effect above would also catch this once
  // `active_corporation_index` changes, but resetting immediately avoids a
  // one-poll-interval flash of Phase 4's buttons for the new corporation).
  /* ==================================================================
   *  DESIGN NOTE 44: THE FORCED MARKET LESSON
   * ==================================================================
   *
   * A first-time president finishes their first Operating Round, and their
   * share price moves LEFT. Nothing on screen explains it, and the natural
   * reading is "I played that badly" -- when in fact every corporation
   * moves left on its first turn, because it has no train yet and so cannot
   * pay out. That is a bad first impression caused entirely by a missing
   * sentence.
   *
   * So this is the one tutorial that INTERRUPTS: it navigates the player to
   * the market chart and opens on top of it, because the lesson is about a
   * thing that just happened to a specific number they can see.
   *
   * TRIGGERED FROM THE ACTION, NOT FROM POLLED STATE. "Did this player just
   * finish their first OR turn" is genuinely hard to infer from
   * `GameStateResponse` -- indices advance, and a poll landing late or
   * twice would fire it at the wrong moment or not at all. Ending the turn
   * is an explicit click by a known viewer, so the click is the signal.
   *
   * GUARDED THREE WAYS, because a modal that interrupts must not do so
   * twice: only for a president (the lesson is about YOUR corporation),
   * only during the FIRST Operating Round, and `TutorialModal`'s own
   * per-topic seen flag and global off switch both still apply -- this
   * arms the modal, it does not bypass anyone's preferences.
   *
   * ==================================================================
   *  DESIGN NOTE 412: AND A FOURTH GUARD, ON THE NAVIGATION ONLY
   * ==================================================================
   *
   * REPORTED: End Turn in an Operating Round forces a redirect to the Stock
   * Market page. It should do that only in tutorial mode.
   *
   * The three guards above are all about the SITUATION and none about the
   * PLAYER, so every experienced player met this exactly once per game and
   * had the board pulled out from under them mid-turn. `tutorialMode`
   * defaults to false -- see `TutorialModal`'s design note #412 for why it
   * is a new opt-in flag rather than the existing off switch inverted --
   * so standard play now ends a turn and stays where it was.
   *
   * THE TAB SWITCH IS GATED; ARMING THE MODAL IS NOT. The explainer is a
   * panel over the screen the player chose and costs one click to dismiss;
   * the navigation is what moves them somewhere they did not ask to go, and
   * it happens BEFORE the modal renders, so dismissing does not undo it.
   * Gating both would silently retire a tutorial that still works for the
   * player it was written for. */
  const handleEndOperatingTurn = useCallback(() => {
    const viewerIsPresident =
      viewerAddress != null &&
      (gameState?.public_companies ?? []).some((c) => c.president === viewerAddress);
    const isFirstOperatingRound = (gameState?.macro_round_number ?? 0) <= 1;

    handlePassTurn();
    setOrSubPhase("Track");

    if (viewerIsPresident && isFirstOperatingRound) {
      if (tutorialModeEnabled()) setActiveMainTab("stock");
      setMarketTutorialArmed(true);
    }
  }, [handlePassTurn, viewerAddress, gameState]);

  // The board. Was `useMemo(() => MOCK_MAP_GRID, [])` -- immutable by
  // construction, which is why laying a tile in sandbox appeared to do
  // nothing: the picker confirmed, and there was no board to write to.
  //
  // State now, so `applySandboxLayTile` can replace it with a NEW object.
  // That identity change is what `HexGridRenderer`'s draw effect watches;
  // mutating the existing `tiles` array in place would leave the reference
  // untouched and the canvas would never repaint.

  /** Applies a confirmed sandbox tile lay: paints the board, charges the
   *  corporation, and moves the turn on.
   *
   *  Three separate things, because they live in three separate places --
   *  the tile grid is its own query document, the treasury is on game state,
   *  and the sub-phase cursor is App-local. Routing the charge through
   *  `runGameplayAction` rather than adjusting the treasury directly keeps
   *  ONE dispatch path: the same `LayTile` message a live game sends, the
   *  same Action Log entry, the same reducer. */
  const handleSandboxLayTile = useCallback(
    (q: number, r: number, tileId: number, orientation: number) => {
      /* Design note #522a: the board write used to happen HERE, beside the
         dispatch. It moved into `runGameplayAction`'s sandbox branch, and
         the move is what makes a tile lay replicate at all.

         A remote client never runs this function -- it receives `LayTile`
         from the log and replays it through the dispatch. With the
         `setMapGrid` outside, that replay charged the treasury and left the
         board blank: the acting player saw their tile and nobody else did.
         Inside, the same message paints the same hex on every client,
         including the one that acted. */
      runGameplayAction("LayTile (sandbox)", {
        LayTile: {
          game_id: gameId,
          protocol_id: actingProtocolId,
          q,
          r,
          tile_id: tileId,
          orientation,
        },
      });

      // A corporation lays one tile per turn, so the Track step is done. This
      // mirrors what `hexmap::execute_lay_tile` does on chain (it advances
      // the cursor off `Track` on success) rather than inventing a sandbox
      // sequencing rule.
      setOrSubPhase("Tokens");
      setPreviewTile(null);
    },
    [runGameplayAction, gameId, actingProtocolId],
  );

  /* Design note #163: the ONE gate. Everything else in the radial selector
     works regardless of whose turn it is. */
  const tileLayDisabledReason = useMemo(() => {
    if (spectator) return "Planning Mode: Tile lay disabled — you are spectating.";
    if (gameState?.current_round_type !== "OperatingRound") {
      return "Planning Mode: Tile lay disabled — track is laid in an Operating Round.";
    }
    if (orSubPhase !== "Track") {
      // DIRECTION-AWARE. This said "past the Track step" unconditionally,
      // which is wrong in the commonest case: from Phase 3 the turn OPENS on
      // `BuyPrivate`, so a player arriving at a fresh Operating Round was
      // told they had missed a step they had not reached yet -- and given no
      // hint that Advance Sub-Phase was the remedy.
      const order = OPERATING_SUB_PHASE_ORDER;
      const before = order.indexOf(orSubPhase) < order.indexOf("Track");
      return before
        ? `Planning Mode: Tile lay disabled — the turn is still on ${orSubPhase}. Advance to Lay Track first.`
        : `Planning Mode: Tile lay disabled — this corporation is past the Track step (now ${orSubPhase}).`;
    }
    // `actingSeatIndex` resolves the ACTING corporation's president during an
    // Operating Round, which is exactly the person entitled to lay here.
    const acting = gameState ? actingSeatIndex(gameState) : null;
    if (acting === null || gameState?.player_addresses[acting] !== viewerAddress) {
      return "Planning Mode: Tile lay disabled — not your corporation's turn.";
    }
    return null;
  }, [spectator, gameState, orSubPhase, viewerAddress]);
  const canLayTileNow = tileLayDisabledReason === null;

  /** What the ring offers. A chain answer is used verbatim; a local one is
      narrowed by `filterSandboxPlacements`, which is the only opinion
      available on that path (that module's design note #0). */
  const radialCandidates = useMemo<readonly LegalTilePlacement[]>(() => {
    if (!radialSelector) return [];
    if (!radialSelector.provisional) return radialSelector.placements;
    return filterSandboxPlacements(radialSelector.placements, {
      mapGrid,
      q: radialSelector.q,
      r: radialSelector.r,
      // Design note #6 in that file: an orientation is only offered if its
      // track actually meets this corporation's network. Without it the
      // rotate gesture cycles through angles that look legal and are not.
      // `undefined` when the reach is unknown, which leaves the previous
      // behaviour rather than emptying the carousel.
      networkHexes: layTrackFocus?.network,
      networkPorts: layTrackFocus?.ports,
      // The era comes from `currentPhase.tint`, the SAME derivation the
      // phase badge displays, rather than a second reading of
      // `current_global_era`.
      era: ERA_FOR_PHASE_TINT[currentPhase?.tint ?? "yellow"],
    });
  }, [radialSelector, mapGrid, currentPhase, layTrackFocus?.network, layTrackFocus?.ports]);

  /* ===================================================================
   *  DESIGN NOTE 173: ROTATE THROUGH LEGAL ANGLES ONLY
   * ===================================================================
   *
   * Click-to-rotate stepped `(orientation + 1) % 6` -- every angle, legal
   * or not. On an edge hex that walks the tile's track off the board, and
   * on an upgrade it walks straight through rotations that sever the track
   * underneath. The player then has to recognise an illegal angle by eye
   * and keep clicking past it, which is precisely the judgement the picker
   * is supposed to be making for them.
   *
   * The legal set is not recomputed here. `radialCandidates` is already
   * `(tile_id, orientation)` PAIRS -- `filterSandboxPlacements` evaluates
   * path preservation per rotation (its design note #4), and a chain answer
   * is per-rotation by construction. So the legal angles for the previewed
   * tile are simply the ones already present for that tile id, and there is
   * no second opinion to drift.
   *
   * Sorted, so the cycle runs in a predictable direction rather than in
   * whatever order the source happened to list them. */
  const legalRotations = useMemo<number[]>(() => {
    if (previewTile === null) return [];
    const angles = radialCandidates
      .filter((placement) => placement.tile_id === previewTile.tileId)
      .map((placement) => placement.orientation);
    return Array.from(new Set(angles)).sort((a, b) => a - b);
  }, [radialCandidates, previewTile]);

  const handleDismissRadial = useCallback(() => {
    setRadialSelector(null);
    setPreviewTile(null);
  }, []);

  const handlePreviewRotate = useCallback(
    ({ q, r }: { q: number; r: number }) => {
      // A click on a DIFFERENT hex while a preview is up means "I have
      // changed my mind about which hex" -- close, and let the next click
      // open the selector there. Rotating a tile the player is no longer
      // looking at would be the wrong reading of that gesture.
      if (!radialSelector || q !== radialSelector.q || r !== radialSelector.r) {
        handleDismissRadial();
        return;
      }
      setPreviewTile((current) => {
        if (!current) return current;
        // Design note #173: step to the next LEGAL angle, wrapping. With
        // one legal rotation this is a no-op, which is correct -- there is
        // nowhere else the tile may face -- and with none it leaves the
        // orientation alone rather than inventing one.
        if (legalRotations.length === 0) return current;
        const at = legalRotations.indexOf(current.orientation);
        const next = legalRotations[(at + 1) % legalRotations.length];
        return next === current.orientation ? current : { ...current, orientation: next };
      });
    },
    [radialSelector, handleDismissRadial, legalRotations],
  );

  /** While a preview is on the board, the canvas belongs to ROTATION -- the
   *  query interceptor is disarmed exactly as it is for route and token
   *  modes, so a rotation costs no chain round-trip. */
  /* Design note #0 in `utils/tokenMigration.ts`: the destination of every
     token on the hex under the previewed tile. Recomputed as the player
     cycles tiles, because a different tile can carry a different number of
     cities. */
  const radialTokenNote = useMemo(() => {
    if (!radialSelector || !previewTile) return null;
    return describeTokenMigration(
      previewTokenMigration(
        mapGrid,
        radialSelector.q,
        radialSelector.r,
        gameState?.public_companies ?? [],
        previewTile.tileId,
      ),
    );
  }, [radialSelector, previewTile, mapGrid, gameState]);

  /* Design note #488b in `RadialTileSelector`: the same migration the caption
     above is phrased from, handed to the ring as MARKERS so every candidate
     thumbnail shows where the tokens on this hex would land on THAT tile.

     One `previewTokenMigration` call per candidate, keyed on its own tile id
     -- the destination city depends on how many cities the candidate carries,
     so a single shared answer would be wrong for every tile but one. It is
     the identical function the caption uses, which is what stops the picture
     and the sentence disagreeing.

     `stationTickerColor` for the fill, so a preview token wears the same
     livery as the real one (design note #428's single palette). */
  const radialStationMarkersFor = useCallback(
    (tileId: number): readonly StationPreviewMarker[] => {
      if (!radialSelector) return [];
      const preview = previewTokenMigration(
        mapGrid,
        radialSelector.q,
        radialSelector.r,
        gameState?.public_companies ?? [],
        tileId,
      );
      if (!preview) return [];
      return preview.migrations.map((entry) => ({
        cityIndex: entry.toCityIndex,
        ticker: entry.ticker,
        color: stationTickerColor(entry.companyId),
      }));
    },
    [radialSelector, mapGrid, gameState],
  );

  /* ==================================================================
   *  DESIGN NOTE 496 (App side): WHOSE TOKEN THE CURSOR IS CARRYING
   * ==================================================================
   *
   * `null` outside a token placement, which is what keeps the generic disc
   * for every other pointer state.
   *
   * THE ORDER MATCHES `cursorMode`'s. A home-station errand (design note
   * #440) names its own corporation and is modal -- the player accepted a
   * prompt to place THAT company's token -- so it wins over the acting
   * corporation exactly as it wins the click. Reading `actingProtocolId`
   * first would put the operating company's livery on a pointer placing
   * somebody else's home token, which is precisely the confusion this
   * cursor exists to remove.
   *
   * A `private-tile` errand is excluded for the same reason it takes the
   * default cursor (design note #444): it ends in the tile picker, and a
   * token-shaped pointer would promise a placement it does not perform. */
  const stationCursorCorporation = useMemo<{ ticker: string; color: string } | null>(() => {
    const companyId =
      homeStationPlacement && homeStationPlacement.kind !== "private-tile"
        ? homeStationPlacement.companyId
        : tokenTargetMode
          ? actingProtocolId
          : null;
    if (companyId === null) return null;
    const ticker =
      gameState?.public_companies.find((entry) => entry.company_id === companyId)?.ticker ||
      stationTickerLabel(companyId);
    if (!ticker) return null;
    return { ticker, color: stationTickerColor(companyId) };
  }, [homeStationPlacement, tokenTargetMode, actingProtocolId, gameState]);

  /* ==================================================================
   *  DESIGN NOTE 523: THE LISTENER IS THE ONLY WRITER
   * ==================================================================
   *
   * The read half of the loop. Everything that changes sandbox state in a
   * room arrives here first, in log order, and is replayed through
   * `runGameplayAction` -- which is requirement 3 and not a stylistic
   * preference: `applySandboxAction` takes a context assembled in that
   * function from `mapGrid`, the market and the era. Calling the reducer
   * directly would replay every action against a context this file would
   * then have to rebuild by hand, and the first field anyone forgot would
   * be a silent divergence rather than a crash.
   *
   * THE TAIL, NOT THE DELTA. `subscribeSandboxLog` hands back the whole
   * ordered log every time (its own design note), and this takes everything
   * past `appliedIndexRef`. A snapshot that arrives twice, out of order, or
   * after a reconnect therefore cannot double-apply or skip -- the cursor
   * decides what is new, not the event.
   *
   * SEQUENTIAL AND AWAITED, for the reason `handleRunTrains` awaits its own
   * loop: the sandbox reducer is synchronous through refs, so firing the
   * tail in parallel would let action N+1 read the state before N wrote it.
   * `replayingRef` additionally stops a second snapshot interleaving with a
   * replay already in flight.
   *
   * `automatic: true` keeps replayed actions off the Undo stack (design
   * note #475). Undo is a LOCAL affordance over a shared log: popping a
   * snapshot cannot unsend somebody else's action, and letting it try would
   * put this browser behind a log it still believes it has applied. */
  const replayingRef = useRef(false);
  useEffect(() => {
    if (!sandbox || !sandboxRoomCode) return undefined;
    let live = true;

    const drain = async (actions: Array<{ index: number; payload: string; id: string; actor: string }>) => {
      if (replayingRef.current) return;
      replayingRef.current = true;
      try {
        for (const action of actions) {
          if (!live) return;
          if (action.index < appliedIndexRef.current) continue;
          const msg = decodeAction(action);
          /* A corrupt entry is SKIPPED PAST, cursor and all. Stopping would
             wedge the room on one bad document; re-reading it every
             snapshot would wedge it in a loop. */
          appliedIndexRef.current = action.index + 1;
          if (!msg) continue;
          // eslint-disable-next-line no-await-in-loop
          await runGameplayAction("Sandbox room", msg, {
            isRemoteReplay: true,
            automatic: true,
          });
        }
        if (live) setSandboxAppliedCount(appliedIndexRef.current);
      } finally {
        replayingRef.current = false;
      }
    };

    const unsubscribe = subscribeSandboxLog(
      sandboxRoomCode,
      (actions) => {
        void drain(actions);
      },
      (message) => setSandboxRoomError(message),
    );
    return () => {
      live = false;
      unsubscribe();
    };
  }, [sandbox, sandboxRoomCode, runGameplayAction]);

  /** Design note #522: opens a room and publishes its code. */
  const handleHostSandboxRoom = useCallback(async () => {
    setSandboxRoomBusy(true);
    setSandboxRoomError(null);
    try {
      const code = await hostSandboxRoom(sandboxSeatRef.current || "host");
      if (!code) {
        setSandboxRoomError("Firestore is not configured in this build.");
        return;
      }
      /* The cursor starts at zero for a room that starts empty, so the host
         replays its own actions from the log exactly as a joiner does --
         one code path, no host special case. */
      appliedIndexRef.current = 0;
      setSandboxAppliedCount(0);
      setSandboxRoomCode(code);
    } catch (error) {
      setSandboxRoomError(error instanceof Error ? error.message : "Could not open the room.");
    } finally {
      setSandboxRoomBusy(false);
    }
  }, []);

  /** Design note #522: joins an existing room and fast-forwards to it. */
  const handleJoinSandboxRoom = useCallback(async (raw: string) => {
    const code = parseRoomCode(raw);
    if (!code) {
      setSandboxRoomError("That is not a room code — they look like JUNO-4T2.");
      return;
    }
    setSandboxRoomBusy(true);
    setSandboxRoomError(null);
    try {
      /* Read the log once before subscribing purely to TELL THE PLAYER
         whether the room exists. An empty log is indistinguishable from a
         wrong code otherwise, and the subscription below would happily
         listen to a room nobody is in. The replay itself is left to the
         listener: doing it here would apply the history twice. */
      const existing = await readSandboxLog(code);
      appliedIndexRef.current = 0;
      setSandboxAppliedCount(0);
      setSandboxRoomCode(code);
      if (existing.length === 0) {
        setSandboxRoomError("Joined — no actions in this room yet.");
      }
    } catch (error) {
      setSandboxRoomError(error instanceof Error ? error.message : "Could not join that room.");
    } finally {
      setSandboxRoomBusy(false);
    }
  }, []);

  /** Leaves the room. The BOARD IS LEFT WHERE IT IS rather than reset: the
   *  player is dropping out of the sync, not abandoning the position, and
   *  wiping a game they can still look at would be a surprising amount of
   *  destruction for a button labelled "Leave". */
  const handleLeaveSandboxRoom = useCallback(() => {
    setSandboxRoomCode(null);
    setSandboxRoomError(null);
    appliedIndexRef.current = 0;
    setSandboxAppliedCount(0);
  }, []);

  const previewRotateArmed = radialSelector !== null && previewTile !== null;

  /** Design note #472: the hex whose tile selector is open, as the
   *  renderer's `"q,r"` key -- or `undefined` when no ring is up.
   *
   *  Derived from `radialSelector` rather than tracked separately: the ring
   *  and the veil must appear and vanish together, and one nullable object
   *  already says whether it is open. */
  const soleFocusKey = useMemo(
    () => (radialSelector ? `${radialSelector.q},${radialSelector.r}` : undefined),
    [radialSelector],
  );

  /** Confirm. Sandbox lays locally; a chain-backed room dispatches. */
  const handleConfirmRadialLay = useCallback(() => {
    if (!radialSelector || !previewTile || !canLayTileNow) return;
    const { q, r } = radialSelector;
    const { tileId, orientation } = previewTile;
    if (sandbox) {
      handleSandboxLayTile(q, r, tileId, orientation);
    } else {
      runGameplayAction("LayTile", {
        LayTile: { game_id: gameId, protocol_id: actingProtocolId, q, r, tile_id: tileId, orientation },
      });
    }
    /* ==============================================================
     *  DESIGN NOTE 444: THE D&H TILE ERRAND ENDS HERE
     * ==============================================================
     *
     * A `private-tile` placement does not intercept the board click -- it
     * only veils -- so this is where its round trip finishes: mark the
     * power spent and put the player back on the tab they came from.
     *
     * MARKED ON THE LAY, NOT ON THE BUTTON PRESS. A player who opens the
     * map, looks at F16 and dismisses the picker has not used their D&H,
     * and the power is still theirs next turn. */
    if (homeStationPlacement?.kind === "private-tile") {
      if (homeStationPlacement.abilityKey) {
        setUsedPrivateAbilities((prev) =>
          new Set(prev).add(homeStationPlacement.abilityKey as string),
        );
      }
      setHomeStationPlacement(null);
      setActiveMainTab(homeStationPlacement.returnTab);
    }
    handleDismissRadial();
  }, [
    radialSelector,
    previewTile,
    canLayTileNow,
    sandbox,
    handleSandboxLayTile,
    runGameplayAction,
    gameId,
    handleDismissRadial,
    actingProtocolId,
    homeStationPlacement,
  ]);


  // Design note #4 in `TrainBadges.tsx`: the shared per-tier countdown, so
  // the action bar tag and every chip quote the same number.
  const currentRustOutlook = useMemo(() => rustOutlook(gameState), [gameState]);


  /* Design note #188: the dividend decision, costed. All four figures come
     from state already on screen -- the corporation's last route revenue,
     its holdings table, and its market price -- so none of this is a new
     source of truth, only arithmetic the player was being left to do. */
  const dividendCorp = gameState?.public_companies.find(
    (c) => c.company_id === actingProtocolId,
  );
  /* Design note #486: the declaration, derived once and shared with the
     dispatch above and the action bar below. `dividendRevenue` is now what
     this turn is WORTH rather than what the field remembers, so the payout
     table cannot list a split for a run that did not happen. */
  const dividendDeclarationNow = dividendDeclaration({
    lastRouteRevenue: dividendCorp?.last_route_revenue,
    skippedRoutes: skippedRoutesThisTurn,
    // Design note #492: the multi-train total this corporation committed at
    // Run Routes, when this session watched it commit one.
    committedRevenue:
      committedRouteRevenue?.protocolId === actingProtocolId
        ? committedRouteRevenue.total
        : null,
  });
  const dividendRevenue = dividendDeclarationNow.revenue;
  const dividendPerShare = dividendDeclarationNow.perShare;

  /* Design note #278: whether the Pay/Withhold choice is binding. `false`
     when this corporation is known to have skipped Routes -- see the state's
     own note for why `null` (unknown) counts as having run. */
  const dividendRevenueIsThisTurn = !skippedRoutesThisTurn;
  const dividendPayouts = useMemo(() => {
    if (!dividendCorp) return [];
    const rows = dividendCorp.player_holdings.map((entry) => ({
      holder: sandboxPlayerLabel(entry.player) ?? truncateAddress(entry.player),
      percentage: entry.percentage,
      amount: dividendPerShare * (entry.percentage / 10),
    }));
    // The bank pool is paid too -- its share goes to the bank, and omitting
    // it would make the listed payouts fail to add up to the revenue.
    if (dividendCorp.bank_pool_percentage > 0) {
      rows.push({
        holder: "Bank Pool",
        percentage: dividendCorp.bank_pool_percentage,
        amount: dividendPerShare * (dividendCorp.bank_pool_percentage / 10),
      });
    }
    return rows.sort((a, b) => b.percentage - a.percentage);
  }, [dividendCorp, dividendPerShare]);

  /* ==================================================================
   *  DESIGN NOTE 434: THE CELL WAS IN HAND AND WAS BEING THROWN AWAY
   * ==================================================================
   *
   * REPORTED: withholding on a $67 corporation moved its token to $60 -- a
   * cell it was never on -- and the token then vanished from the matrix.
   *
   * `marketGrid.positions` carries `(x, y, price)` per corporation. This
   * read that entry, kept ONLY the price, and handed the bare number to
   * `projectDividendMove`, which had to find a cell again by searching
   * `PRICE_GRID` for that price. The chart repeats prices across rows and
   * the search returns the FIRST match, so a token correctly parked in the
   * $67 par box at `(6, 5)` was projected from `(1, 10)` -- the $67 in the
   * top row -- and one step left of THAT is `(0, 10)`, which is $60.
   *
   * The coordinates were never ambiguous; they were discarded one line
   * before the code that needed them.
   *
   * SAME FAMILY AS DESIGN NOTE #415, and worth naming as such: that was
   * `marketCellForPrice` resolving a PAR to the wrong cell, this is the
   * same first-match search resolving a MOVE from the wrong cell. Both come
   * from treating a price as an address on a board where it is not one.
   *
   * The projection now carries the cell through, so the readout, the action
   * log and the token itself all step from the coordinate the marker is
   * actually standing on -- and all three use `projectDividendCellMove`,
   * which the token move already used. That is why the token appeared to
   * disagree with its own preview: it was the only one of the three doing
   * it correctly. */
  const dividendCell = useMemo(
    () => marketGrid?.positions.find((p) => p.company_id === actingProtocolId) ?? null,
    [marketGrid, actingProtocolId],
  );
  const dividendPrice = useMemo(
    () => (dividendCell?.price != null ? Number(dividendCell.price) : null),
    [dividendCell],
  );
  const payProjection = useMemo(
    () => projectDividendFrom(dividendCell, "pay"),
    [dividendCell],
  );
  const withholdProjection = useMemo(
    () => projectDividendFrom(dividendCell, "withhold"),
    [dividendCell],
  );


  // Design note #28: the phase tab shares the workspace shell (canvas pane
  // + contextual panel) with the map and market tabs.
  const isWorkspaceTab =
    activeMainTab === "phase" ||
    activeMainTab === "corps" ||
    activeMainTab === "map" ||
    activeMainTab === "stock";

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
      <style>{PHASE_SHIFT_PULSE_CSS}</style>
      {isMyTurn && <div style={styles.turnPulseOverlay} aria-hidden="true" />}

      {/* Hotseat dev toolbar. Rendered ONLY in the sandbox branch, so it is
          structurally impossible to reach in a live game -- the same
          containment the phase switcher it absorbed already relied on. Sits
          above every other chrome element because it changes what the whole
          screen means: which player you are looking at. */}
      {sandbox && (
        <SandboxToolbar
          gameState={sandboxState}
          seatIndex={sandboxSeatIndex}
          onSelectSeat={handleSelectSandboxSeat}
          autoFollow={sandboxAutoFollow}
          onToggleAutoFollow={handleToggleSandboxAutoFollow}
          scenario={sandboxScenarioId}
          onSelectScenario={setSandboxScenarioId}
          trainFixture={sandboxTrainFixture}
          onToggleTrainFixture={() =>
            setSandboxTrainFixture((current) => (current === "spread" ? "default" : "spread"))
          }
        />
      )}

      {/* Design note #32: FTUE. Mounted at the shell level, not inside the
          phase panels, so a modal survives its panel unmounting on a tab
          switch -- one that vanished when you clicked Rail Map to look at
          the board would have to be re-triggered to finish reading.

          Design note #39: THREE topics, one per round. All three are
          mounted unconditionally and each decides for itself whether to
          open, keyed on its own `active`. That is safe against two firing
          at once because `current_round_type` is a single value -- the
          three `active` flags are mutually exclusive by construction, not
          by coordination between them. Each also tracks its own "seen"
          flag, so a player who read the auction explainer still gets the
          Stock Round one when the game reaches it. */}
      <TutorialModal
        topicKey="waterfall-auction"
        heading="Waterfall Auction"
        pages={WATERFALL_AUCTION_TUTORIAL}
        active={isWaterfallPhase}
      />
      <TutorialModal
        topicKey="stock-round"
        heading="Stock Round"
        pages={STOCK_ROUND_TUTORIAL}
        active={gameState?.current_round_type === "StockRound"}
      />
      <TutorialModal
        topicKey="operating-round"
        heading="Operating Round"
        pages={OPERATING_ROUND_TUTORIAL}
        active={gameState?.current_round_type === "OperatingRound"}
      />
      {/* Design note #44: the only tutorial not keyed to a round type. It
          opens on an event -- the player's first OR turn ending -- and the
          tab switch that precedes it is deliberate, not incidental. */}
      <TutorialModal
        topicKey="stock-market"
        heading="The Stock Market"
        pages={STOCK_MARKET_TUTORIAL}
        active={marketTutorialArmed}
      />

      {/* Design note #332: the mandatory buy the treasury cannot fund.
          Mounted at the shell level beside the tutorials rather than inside
          the Operating Round panel, because it is a full-screen decision
          about the PRESIDENT's money -- the corporation's own panels are
          about the corporation's. */}
      {/* Design note #399: blocking, because until it is answered the B&O
          is presided over with no price -- a state design note #387 refuses
          to render a token or a figure for. */}
      <BoParPrompt
        open={boParPrompt !== null}
        winnerLabel={
          boParPrompt
            ? sandboxPlayerLabel(boParPrompt.player) ?? truncateAddress(boParPrompt.player)
            : ""
        }
        onConfirm={handleConfirmBoPar}
      />

      {/* Design note #416: blocking, for the same reason the B&O prompt is
          -- a floated corporation owes its home station and 1830 has no
          branch where it declines one. Mounted at shell level beside the
          other two prompts rather than inside the map panel, because it can
          fire while the player is on any tab. */}
      {/* Design note #440: the modal hides itself once the player has
          accepted it and been sent to the map -- a backdrop over the board
          they were just asked to click would be the flow blocking its own
          final step. `pendingHomeToken` stays true throughout (the token is
          still owed until the click lands), which is what brings the prompt
          back if the placement is somehow abandoned. */}
      <HomeStationPrompt
        pending={homeStationPlacement ? null : pendingHomeToken}
        presidentLabel={
          pendingHomeToken?.president
            ? sandboxPlayerLabel(pendingHomeToken.president) ??
              truncateAddress(pendingHomeToken.president)
            : null
        }
        liveryColor={
          pendingHomeToken ? stationTickerColor(pendingHomeToken.companyId) : "#171c28"
        }
        liveryInk={
          pendingHomeToken
            ? bestContrastTextColor(stationTickerColor(pendingHomeToken.companyId))
            : "#eaf2ff"
        }
        onPlace={handlePlaceHomeStation}
      />

      <EmergencyTrainPurchaseModal
        plan={emergencyModalPlan}
        sandbox={sandbox}
        /* Design note #1 in the modal: the forced sale. Dispatches the
           ordinary `SellStock` with the block the modal has already
           validated against both restrictions -- the legality lives in
           `endgame.ts`, so what reaches the reducer is a sale that was
           legal at the moment the button was drawn. */
        onSellShares={(companyId, percentage) => {
          void runGameplayAction("SellStock: emergency funding", {
            SellStock: { game_id: gameId, protocol_id: companyId, percentage },
          });
        }}
        onConfirm={() => {
          const plan = emergencyModalPlan;
          if (!plan) return;
          /* Design note #333: `EmergencyBuyHardware`, NOT the ordinary
             `BuyHardwareFromPool`. They are different contract messages and
             the difference is the whole feature -- the ordinary one charges
             the treasury and floors at zero, which in this state would buy
             the train without anyone paying the shortfall. The log line is
             written by `runGameplayAction` from the resolved state, so it
             reports what actually moved rather than what was intended. */
          void runGameplayAction(
            `EmergencyBuyHardware: ${plan.trainModel}-train`,
            { EmergencyBuyHardware: { game_id: gameId, protocol_id: plan.corporationId } },
          );
          logInfo(
            "Emergency Purchase",
            `${plan.presidentLabel} covered $${plan.shortfall} of ${plan.corporationTicker}'s $${plan.trainCost} ${plan.trainModel}-train — $${plan.treasuryContribution} treasury, $${plan.fromPlayerCash} personal cash.`,
          );
        }}
      />

      {/* Design note #0 in `GameOverModal.tsx`: both endings, one surface.
          Mounted above the emergency modal in z-order because bankruptcy is
          declared FROM that modal -- the game ending has to be able to
          cover the screen the president was looking at when it happened. */}
      <GameOverModal
        reason={gameEndReason}
        standings={finalStandings}
        viewerAddress={viewerAddress}
        totalAnte={PLACEHOLDER_TOTAL_ANTE}
        bankruptLabel={bankruptLabel}
      />

      {/* Design note #34: one bar. The room context below used to be a
          second full-width strip of its own; it is now the middle of the
          single header. It still says WHICH room this shell is bound to --
          every query and action targets `gameId`, and someone with two tabs
          open needs to tell them apart -- and is still the only place
          `chatError` surfaces, because chat failing silently is worse than
          chat saying it is broken. */}
      <TopBar
        onLeaveGame={onLeaveGame}
        roomContext={
          <>
        {/* Design note #23: says plainly what mode this is, because a
            read-only board is otherwise indistinguishable from a board where
            it simply is not your turn. */}
        {spectator && <span style={styles.spectatorBadge}>👁 SPECTATING &middot; read-only</span>}
        {sandbox ? (
          // Design note #24: neither id means anything here, so neither is
          // shown. Displaying "game #0" would invite someone to go looking
          // for game 0 on chain.
          <>
            <span style={styles.sandboxBadge}>🧪 OFFLINE SANDBOX</span>
            {/* The phase switcher that stood here MOVED into
                `SandboxToolbar`, which now owns every sandbox-only control.
                Two separate places to change sandbox settings -- one in the
                room strip, one in a banner -- is worse than one, and the
                seat switcher has to live in the banner because it needs the
                room for four buttons. */}
            <span style={styles.roomStripLabel}>
              Mock state &middot; hotseat controls above
            </span>
          </>
        ) : (
          <>
            <span style={styles.roomStripLabel}>
              ⛓ On-chain game <strong style={styles.roomStripValue}>#{gameId}</strong>
            </span>
            <span style={styles.roomStripDivider} aria-hidden="true" />
            <span style={styles.roomStripLabel} title={`Firestore room ${roomId}`}>
              💬 Room <strong style={styles.roomStripValue}>{truncateAddress(roomId, 6, 4)}</strong>
            </span>
          </>
        )}
            {chatError && <span style={styles.roomStripError}>{chatError}</span>}
          </>
        }
      />

      <MainTabBar
        activeTab={activeMainTab}
        onSelect={setActiveMainTab}
        roundType={gameState?.current_round_type ?? null}
        onOpenTutorials={() => setTutorialLibraryOpen(true)}
      />
      {/* Design note #158: the on-demand reader. Rendered alongside the four
          auto-opening modals rather than inside the tab bar -- it is a modal
          over the whole shell, not a part of the navigation that summons
          it. */}
      <TutorialLibrary
        open={tutorialLibraryOpen}
        onClose={() => setTutorialLibraryOpen(false)}
      />

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
            {/* Design note #31: THE one action bar, hoisted above the
                phase branch so it renders on every active tab -- auction,
                stock round and rail map alike. It used to live inside the
                non-auction branch only, which is why the auction grew its
                own Pass and the phase tab ended up with two bars. */}
                {/* Item 5: contextual gameplay action bar -- see design notes
                    #8/#10. Step-by-step OR sub-phase guidance is design note
                    #10/item 2.

                    Design note #23: hidden entirely for spectators. This is
                    the COURTESY half of read-only mode -- the guarantee is
                    `runGameplayAction`'s gate, which holds whether or not
                    this bar renders. Hidden rather than disabled because a
                    row of twenty greyed-out buttons is visual noise offering
                    a spectator nothing; the badge in the room strip already
                    explains why they are gone. */}
                {/* Design note #521: sandbox multiplayer, offered rather than
                    demanded -- solo play needs no gesture. Above the action
                    bar and outside the spectator branch: a spectator has no
                    action bar (design note #23) and the room strip is not an
                    action, so hiding it with the controls would take away the
                    one thing a watcher might legitimately want. */}
                {sandbox && (
                  <SandboxRoomBar
                    roomCode={sandboxRoomCode}
                    available={isFirebaseConfigured()}
                    appliedCount={sandboxAppliedCount}
                    error={sandboxRoomError}
                    busy={sandboxRoomBusy}
                    onHost={handleHostSandboxRoom}
                    onJoin={handleJoinSandboxRoom}
                    onLeave={handleLeaveSandboxRoom}
                  />
                )}
                {spectator ? (
                  <div style={styles.spectatorNotice}>
                    👁 Watching game #{gameId}. Board, ledger and market are live; every action
                    control is hidden. Join a room from the lobby to play.
                  </div>
                ) : (
                <ContextualActionBar
                  /* Design note #500: `latestFeedItem`/`onOpenActivityLog`
                     are gone. The bar no longer echoes the activity log --
                     `TopTicker` above carries it, from this same
                     `latestFeedItem`. */
                  roundType={gameState?.current_round_type ?? null}
                  /* Design note #517: the board's own round numbering, from
                     the same two fields `ContextualSubPanel` prints as
                     "OR n.m". `null` before the first poll. */
                  orSequence={
                    gameState
                      ? {
                          cycle: gameState.macro_round_number,
                          index: gameState.sub_round_index,
                        }
                      : null
                  }
                  // Design note #390: the bar compares these two and
                  // replaces itself with a Return button when the player is
                  // on another round's playing surface.
                  activeTab={activeMainTab}
                  onSelectTab={setActiveMainTab}
                  orSubPhase={orSubPhase}
                  sessionReady={controlsEnabled}
                  // Design note #31: PHASE-APPROPRIATE PASS. `WaterfallPass`
                  // and `PassTurn` are different contract messages, not one
                  // action with two names -- sending the wrong one would
                  // fail with an error about turn state that mentions
                  // nothing to do with passing.
                  onPassTurn={isWaterfallPhase ? handleWaterfallPass : handlePassTurn}
                  /* ==================================================
                       DESIGN NOTE 311: PASSING IS ALWAYS LEGAL
                      ==================================================

                      REPORTED: Pass Turn is greyed out for the very first
                      player of the auction.

                      It was, and for every player, until somebody bid. The
                      gate read "passing is illegal until at least one
                      private has a standing bid" -- which is not an 1830
                      rule and had the auction's own escape hatch backwards.
                      An opening table with no bids anywhere is exactly the
                      position the pass rule exists FOR: if all four players
                      decline in succession, the cheapest private is marked
                      down $5 and the round comes back around cheaper.
                      Requiring a bid before anyone could pass made that
                      markdown unreachable from the opening position, so the
                      first player's only legal moves were to buy Schuylkill
                      Valley at full price or to bid.

                      `sandboxSession.ts`'s `WaterfallPass` branch has
                      implemented the markdown since design note #271. This
                      gate was the only thing standing in front of it.

                      WHAT IS STILL BLOCKED, and it is a different question:
                      a live mini-auction. `WaterfallPass` and
                      `WaterfallMiniAuctionPass` are separate messages
                      against separate cursors, and sending the former while
                      a contest is running advances the main seat pointer
                      out from under the mini-auction -- the same class of
                      cursor desync as design note #310. Dropping out of a
                      contest is the Drop out button on the card. */
                  passDisabledReason={
                    isWaterfallPhase && waterfallState?.mini_auction
                      ? "A mini-auction is running — use Drop out on the highlighted company card to leave it."
                      : null
                  }
                  onPlaceStationTokenHint={handlePlaceStationTokenHint}
                  stationTokenCost={stationTokenCost}
                  activeCorporation={activeCorporationContext}
                  tokenTargetMode={tokenTargetMode}
                  setTokenTargetMode={setTokenTargetMode}
                  onSkipSubPhase={handleSkipSubPhase}
                  onOpenPrivateTrade={() => setPrivateTradeOpen(true)}
                  ownsAnyTrain={ownsAnyTrain}
                  mustBuyTrain={mustBuyTrain}
                  activePlayerName={activeSeatLabel}
                  activePlayerCash={activeSeatCash}
                  activePlayerEscrow={activeSeatEscrow}
                  playerRoster={playerRoster}
                  privateCompanies={gameState?.private_companies ?? []}
                  privatePowerViewer={viewerAddress}
                  sandboxMode={sandbox}
                  usedPrivateAbilities={usedPrivateAbilities}
                  onUsePrivateAbility={handleUsePrivateAbility}
                  onRunTrains={handleRunTrains}
                  onPayDividends={handlePayDividends}
                  onWithholdRevenue={handleWithholdRevenue}
                  /* Design note #508: the Buy Trains panels are rendered BY
                     the bar now, so they inherit its stickiness and travel
                     with it. Passed as one object -- the bar is a conduit for
                     these, not a reader of them. */
                  trainPurchase={
                    gameState && orSubPhase === "Hardware"
                      ? {
                          depot,
                          buyer:
                            gameState.public_companies.find(
                              (company) => company.company_id === actingProtocolId,
                            ) ?? null,
                          companies: gameState.public_companies,
                          canAct:
                            sandbox ||
                            (viewerAddress !== null &&
                              gameState.public_companies.find(
                                (company) => company.company_id === actingProtocolId,
                              )?.president === viewerAddress),
                          blockedReason: trainOffers.some(
                            (offer) => offer.buyer_protocol_id === actingProtocolId,
                          )
                            ? "One offer at a time — answer or rescind the outstanding one first."
                            : null,
                          onBuyFromBank: handleBuyTrainsFromBank,
                          onProposeTrade: handleProposeTrainTrade,
                          labelForAddress: (address: string) =>
                            sandboxPlayerLabel(address) ?? truncateAddress(address),
                        }
                      : null
                  }
                  dividendRevenue={dividendRevenue}
                  dividendRevenueIsThisTurn={dividendRevenueIsThisTurn}
                  dividendPerShare={dividendPerShare}
                  dividendPayouts={dividendPayouts}
                  rustOutlookForBar={currentRustOutlook}
                  dividendPrice={dividendPrice}
                  payProjection={payProjection}
                  withholdProjection={withholdProjection}
                  selectedHardwareModel={selectedHardwareModel}
                  onEndOperatingTurn={handleEndOperatingTurn}
                  onUndoLastAction={handleUndoLastAction}
                  phase={currentPhase}
                  // Design note #493: an action, not a mode.
                  onAutoRoute={handleAutoRouteAgain}
                  onSelectRouteTrain={handleSelectRouteTrain}
                  highlightedRouteIndex={highlightedTrainIndex}
                  onHighlightRoute={setHighlightedTrainIndex}
                  trainDrafts={trainDrafts}
                  activeTrainIndex={activeTrainIndex}
                  routeFeedback={routeFeedback}
                  onClearRoute={handleClearRoute}
                  currentGlobalEra={gameState?.current_global_era ?? null}
                  isMyTurn={isMyTurn}
                />
                )}

            {isWaterfallPhase && activeMainTab === "phase" ? (
              /* Pre-Game Waterfall Auction (`waterfall.rs`): replaces the
                 normal action bar + board + contextual panel for this phase
                 -- see `WaterfallAuctionDashboard.tsx`'s own doc comment for
                 why a dedicated dashboard, not a mode grafted onto
                 `ContextualActionBar`, is the right shape for six privates'
                 worth of bid trackers.

                 BUG FIX (design note #27): `&& activeMainTab === "stock"` is
                 new and is the whole fix for "the Rail Map tab just
                 re-renders the auction screen".

                 This branch sits inside `isWorkspaceTab`, which is TRUE FOR
                 BOTH the map and stock tabs. So while `isWaterfallPhase`
                 held, the auction dashboard replaced the workspace on
                 EITHER tab -- clicking "Rail Map" dutifully set
                 `activeMainTab` to `"map"`, and then this ternary rendered
                 the auction anyway, because nothing here consulted the tab.
                 The tab button worked perfectly and had no visible effect,
                 which is the worst kind of broken.

                 Worth stating plainly: this was NOT a sandbox bug. The
                 sandbox only made it easy to hit, by letting someone sit in
                 the auction phase indefinitely and click around. In a real
                 game the rail map would have been equally unreachable for
                 the whole of the private auction -- during which players
                 have every reason to study the board they are about to
                 compete over. */
              <WaterfallAuctionDashboard
                waterfallState={waterfallState}
                loading={waterfallStateLoading}
                error={waterfallStateError}
                gameState={gameState}
                connectedWalletAddress={viewerAddress}
                playerLabel={sandbox ? sandboxPlayerLabel : undefined}
                // Design note #30 in that file: pass-and-play has no wallet
                // to compare a turn against, so the seat on turn is always
                // the one this keyboard may act for.
                hotseat={sandbox}
                settledPrices={settledPrivatePrices}
                // Design note #306 in that file: the auction is over and
                // somebody has to open the Stock Round. Sandbox only --
                // a live chain advances its own round, and a client button
                // there would be a lie.
                onProceedToStockRound={sandbox ? handleProceedToStockRound : undefined}
                sessionReady={controlsEnabled}
                onBuyLowest={handleWaterfallBuyLowest}
                onBidHigher={handleWaterfallBidHigher}
                onMiniAuctionRaise={handleWaterfallMiniAuctionRaise}
                onMiniAuctionPass={handleWaterfallMiniAuctionPass}
              />
            ) : (
              <>
                {/* Audit G-15: train trading, shown only during the Buy
                    Trains step.
                    
                    Safe to gate this tightly, and worth spelling out why: an
                    offer can only be CREATED in the Hardware phase, and while
                    one is outstanding the buyer's turn is blocked there
                    (`operations::PendingTrainOfferBlocksTurn`). So an offer
                    cannot outlive the phase that produced it, and hiding the
                    panel elsewhere hides nothing a player could act on.
                    
                    `orSubPhase` tracks the ACTIVE corporation's step, not the
                    viewer's, so a seller still sees this during the buyer's
                    Hardware phase -- which is the only time their answer is
                    wanted. */}
                {/* Design note #203: the Buy Trains step's own panel -- the
                    bank depot and the corporate marketplace, in that order,
                    with the second collapsed. Same `orSubPhase === "Hardware"`
                    gate the offer ledger below uses. */}
                {/* ===================================================================
                     DESIGN NOTE 419: THE TRAIN PANELS BELONG TO ONE TAB
                    ===================================================================

                     REPORTED: the Buy Trains from Bank panel bleeds into the
                     Stocks and Stock Market tabs.

                     It did, and the gate below is why it was easy to miss:
                     `current_round_type === "OperatingRound" && orSubPhase
                     === "Hardware"` is a precise, correct statement about
                     WHEN this panel applies, and says nothing about WHERE.

                     This whole branch sits inside `isWorkspaceTab`, which is
                     true for four tabs -- `phase`, `corps`, `map` and
                     `stock`. So during an Operating Round's Buy Trains step
                     the panel rendered on every one of them, including the
                     two whose entire subject is share trading.

                     THIS IS DESIGN NOTE #27'S BUG AGAIN. That note fixed the
                     auction dashboard hijacking the Rail Map by adding a tab
                     test to a condition that had only a phase test, and
                     wrote down the lesson: a panel inside `isWorkspaceTab`
                     must say which workspace it is for. The Stock Round panel
                     beside this one learned it (`activeMainTab === "corps"`).
                     The train panels did not.

                     `surfaceTabFor("OperatingRound")` rather than a literal
                     `"map"`, so if the Operating Round's home tab ever moves,
                     this follows it instead of quietly pointing at the wrong
                     surface -- the same anti-drift reason the round
                     transitions already call it rather than naming tabs. */}
                {/* Design note #508: `TrainPurchasePanel` used to mount here,
                    below the action bar. It is rendered BY the bar now, so it
                    inherits the bar's stickiness and travels with the player
                    instead of scrolling away -- which is also what retired
                    design note #491's jump button. */}
                {/* ===================================================================
                     DESIGN NOTE 233: THE LEDGER APPEARS WHEN THERE IS ONE
                    ===================================================================

                    This rendered on every Hardware step, empty, reading "No
                    offers outstanding" -- a permanent panel whose permanent
                    content was that it had nothing to show. Worse, it sat
                    directly under the purchase panel, so the first thing a
                    player saw when they went to buy a train was a heading
                    about offers that did not exist.

                    A pending offer is an EVENT. It arrives, it blocks a
                    turn, it gets answered, it goes away -- so the panel that
                    represents it should do the same. `viewerTrainOffers`
                    below is the gate, and it is scoped to offers the viewer
                    is actually party to rather than to any offer in the
                    room, because this is the surface where they ANSWER one.
                    The prompt (design note #218) is the interruption; this
                    is the record beside it.

                    Design note #1 in that file argued a pending offer is
                    public information and should be visible to everyone.
                    That is still true and is what the Action Log carries; a
                    dedicated panel on the buy screen is a different claim --
                    that you have something to do here. */}
                {/* Design note #419: the offer ledger is the purchase
                    panel's sibling and leaked identically -- same phase
                    gate, same missing tab gate, same four tabs. Fixed
                    together, because a fix that left the ledger bleeding
                    onto the Stock Market tab would have answered the report
                    rather than the bug. */}
                {activeMainTab === surfaceTabFor("OperatingRound") &&
                  gameState?.current_round_type === "OperatingRound" &&
                  orSubPhase === "Hardware" &&
                  viewerTrainOffers.length > 0 && (
                  <TrainTradePanel
                    // Design note #6 in that file: the compose form moved to
                    // `TrainPurchasePanel`; this renders the offer LEDGER.
                    composeEnabled={false}
                    offers={trainOffers}
                    companies={(gameState?.public_companies ?? []).map((company) => ({
                      company_id: company.company_id,
                      ticker: company.ticker,
                      president: company.president ?? null,
                      // Audit G-15c: drives the greyed-out model options.
                      // Passed through UNCHANGED, `undefined` included --
                      // that value means "this chain doesn't say", and the
                      // panel treats it differently from an empty list.
                      owned_train_models: company.owned_trains,
                    }))}
                    activeProtocolId={
                      gameState.active_operating_order[gameState.active_corporation_index] ?? null
                    }
                    connectedAddress={viewerAddress}
                    sessionReady={controlsEnabled}
                    onMakeOffer={handleMakeTrainOffer}
                    onAccept={handleAcceptTrainOffer}
                    onReject={handleRejectTrainOffer}
                    onRescind={handleRescindTrainOffer}
                  />
                )}

                {/* Stock Round (SR) Action Control Panel -- requirement 1's
                    "directly above ... the Stock Market Matrix." Gated on
                    a live Stock Round so it never renders during Operating
                    Round (Waterfall bypasses this whole branch already, via
                    `isWaterfallPhase` above).

                    ALSO gated on the stock tab (design note #27). This is
                    the same class of problem as the auction hijacking the
                    Rail Map, caught while fixing it: the panel is not
                    exclusive -- it renders ABOVE the canvas rather than
                    instead of it -- so the map was still technically there.
                    But the panel now leads with an eight-card corporation
                    roster, which pushed the rail map most of a screen down.
                    "Visible if you scroll far enough" is not the Rail Map
                    tab doing its job. Its controls are all Stock-Round
                    actions and belong with the market. */}
                {/* Design note #41: gated on the TAB alone, not on the round.
                    The roster is a reference surface now -- it renders in an
                    Operating Round and during the auction too, because
                    "what do I own and what is it worth" does not stop being
                    a question when the Stock Round ends. Its Buy/Sell
                    controls are separately gated on `isMyTurn` and session
                    readiness, so an out-of-phase viewer reads but cannot
                    act. */}
                {activeMainTab === "corps" && (
                  <StockRoundPanel
                    publicCompanies={gameState?.public_companies ?? []}
                    // Design note #395 in that file: each card lists the
                    // privates its own corporation holds, expandable to
                    // their rules text.
                    privateCompanies={gameState?.private_companies}
                    // Design note #398: a lookup, not one shared string.
                    parValueFor={parValueFor}
                    // Design note #356/#357: the round number bans SR1
                    // sales; the acting seat's cash gates every buy.
                    macroRoundNumber={gameState?.macro_round_number}
                    playerCash={activeSeatCash}
                    onSelectParValue={handleSelectParValue}
                    onBuyShare={handleBuyShare}
                    onSellShares={handleSellShares}
                    sessionReady={controlsEnabled}
                    isMyTurn={isMyTurn}
                    connectedAddress={viewerAddress}
                    // Design note #31 in that file: powers the front-face
                    // operating snapshot -- train limit and which tier is
                    // about to rust.
                    phase={currentPhase}
                    outlook={currentRustOutlook}
                    // Design note #8 in that file: market price is separate
                    // data (`GetMarketGrid`) from the ownership registry.
                    // Only the sandbox has it wired so far -- a live game
                    // passes `undefined` and the roster renders a dash,
                    // which is honest about not knowing rather than
                    // inventing a price.
                    // Design note #2 in `sandboxState.ts`: ONE price, two
                    // renderers. This read the frozen `SANDBOX_MARKET_PRICES`
                    // constant while the chart now reads the live atom, which
                    // is the exact drift that note exists to prevent -- a
                    // card saying $76 beside a token sitting on $71.
                    marketPrices={sandbox ? sandboxMarketPrices : undefined}
                    playerLabel={sandbox ? sandboxPlayerLabel : undefined}
                    hotseat={sandbox}
                    // Design note #34 in that file: the header names the
                    // seat that is up rather than telling the player to
                    // wait for themselves.
                    activePlayerLabel={activeSeatLabel}
                    // Design note #41: the roster is readable in every
                    // phase, but shares only trade in a Stock Round.
                    // Design note #464: the card-order boundary.
                    roundType={gameState?.current_round_type ?? null}
                    actionsLockedReason={
                      gameState?.current_round_type === "StockRound"
                        ? null
                        : "Viewing only — shares can be bought and sold during a Stock Round."
                    }
                  />
                )}

                {/* Design note #28: the phase tab renders NO reference
                    board. Its content is the phase panel above -- the
                    auction dashboard or the Stock Round cards -- and the
                    2D market chart now has its own tab. Rendering the
                    chart here too is what the old single-tab design did,
                    and it is precisely the conflation this note split
                    apart: a player on the Stock Round tab is choosing
                    shares, not reading the chart, and the chart is one
                    click away when they want it. */}
                {/* Design note #45: AN ALLOWLIST, NOT A DENYLIST.
                    This read `activeMainTab !== "phase"`, which silently
                    assumed the only workspace tabs were the phase surface,
                    the map and the chart. Adding `"corps"` (design note
                    #41) therefore opted it in by default: the Stocks tab
                    passed the `!== "phase"` test, fell past the `=== "map"`
                    branch, and rendered a second copy of the Stock Market
                    matrix underneath the corporation cards.
                    
                    Naming the two tabs that OWN a board means a future tab
                    has to ask for one rather than inherit it. */}
                {/* Design note #1 in `RadialTileSelector`: the radial ring
                    anchors to the board pane's live rect rather than to the
                    viewport, so a page scroll moves the two together instead
                    of leaving the menu behind. A callback ref, so a re-mount
                    re-measures rather than holding a stale node. */}
                {(activeMainTab === "map" || activeMainTab === "stock") && (
                <div style={styles.boardPane} ref={setBoardEl}>
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
                      // Design note #24: SANDBOX FORCES THE OFFLINE PATH.
                      // Withholding `contractAddress` (and the client) is
                      // not merely tidy -- it is the mechanism. Per
                      // HexGridRenderer's own design note #139, a missing
                      // client OR a missing contract address means "there
                      // is no chain to ask", which routes a hex click into
                      // `localCatalogPlacements()` and opens the picker in
                      // `offline` mode against the local tile catalog.
                      // That is exactly the browsable, chain-free tile
                      // picker the sandbox exists to provide, and it is
                      // machinery that already existed -- sandbox mode just
                      // guarantees the conditions for it.
                      //
                      // Withholding it also prevents the alternative, which
                      // is worse than useless: `CONTRACT_ADDRESS` is a
                      // non-empty MOCK string, so it is truthy, so without
                      // this the interceptor would fire a real
                      // `GetLegalTilePlacements` at a contract that does not
                      // exist and every click would surface a query error
                      // instead of a tile picker.
                      // Design note #159: token targeting disarms the tile
                      // picker exactly as route mode does. Both modes want
                      // the same thing -- the click, and not the picker --
                      // so they gate the same four props.
                      // Design note #162: `previewRotateArmed` joins route
                      // and token mode as a third reason to disarm the
                      // query interceptor. All three want the raw click
                      // rather than a tile picker.
                      // Design note #199, layer 2: `!tileInspectorArmed` joins
                      // the three mode flags. Outside the Lay Track sub-phase
                      // the interceptor is disarmed entirely, so a stray board
                      // click costs no `GetLegalTilePlacements` round-trip and
                      // cannot open a carousel over a board whose click means
                      // something else.
                      queryClient={
                        !tileInspectorArmed ||
                        routeSelectMode ||
                        tokenTargetMode ||
                        /* Design note #440/#444: a TOKEN placement owns the
                           board and the picker must not open over it. The
                           tile errand is the opposite -- it needs the picker,
                           so it deliberately does not disarm here. */
                        (homeStationPlacement !== null &&
                          homeStationPlacement.kind !== "private-tile") ||
                        /* Design note #440/#444: a TOKEN placement owns the
                           board and the picker must not open over it. The
                           tile errand is the opposite -- it needs the picker,
                           so it deliberately does not disarm here. */
                        (homeStationPlacement !== null &&
                          homeStationPlacement.kind !== "private-tile") ||
                        /* Design note #440/#444: a TOKEN placement owns the
                           board and the picker must not open over it. The
                           tile errand is the opposite -- it needs the picker,
                           so it deliberately does not disarm here. */
                        (homeStationPlacement !== null &&
                          homeStationPlacement.kind !== "private-tile") ||
                        /* Design note #440/#444: a TOKEN placement owns the
                           board and the picker must not open over it. The
                           tile errand is the opposite -- it needs the picker,
                           so it deliberately does not disarm here. */
                        (homeStationPlacement !== null &&
                          homeStationPlacement.kind !== "private-tile") ||
                        previewRotateArmed ||
                        spectator ||
                        sandbox
                          ? undefined
                          : queryClient
                      }
                      contractAddress={
                        !tileInspectorArmed ||
                        routeSelectMode ||
                        tokenTargetMode ||
                        previewRotateArmed ||
                        sandbox
                          ? undefined
                          : CONTRACT_ADDRESS
                      }
                      gameId={
                        !tileInspectorArmed ||
                        routeSelectMode ||
                        tokenTargetMode ||
                        previewRotateArmed
                          ? undefined
                          : gameId
                      }
                      protocolId={
                        !tileInspectorArmed ||
                        routeSelectMode ||
                        tokenTargetMode ||
                        previewRotateArmed
                          ? undefined
                          : actingProtocolId
                      }
                      cursorMode={
                        /* Design note #440: a home placement arms the same
                           crosshair the ordinary token step uses -- the
                           gesture a player is being asked for is identical,
                           so the cursor should not differ. */
                        /* Design note #444: the TILE errand keeps the
                           default cursor -- it ends in the tile picker, and
                           a crosshair would promise a token placement. */
                        (homeStationPlacement &&
                          homeStationPlacement.kind !== "private-tile") ||
                        tokenTargetMode
                          ? "token"
                          : "default"
                      }
                      /* Design note #496: whose token this is. Read from the
                         SAME two sources the cursor mode above is armed from,
                         in the same order -- a home placement names its own
                         corporation, and the ordinary token step is the
                         acting one. Reading them separately is how the
                         pointer ends up wearing the wrong livery on a D&H
                         errand. */
                      tokenCursor={stationCursorCorporation}
                      onHexClick={
                        /* Design note #440: FIRST in the chain. A home
                           placement is modal in intent -- the player has
                           accepted a prompt and been sent here to do one
                           thing -- so it takes the click ahead of every
                           other board mode rather than competing with
                           whichever happened to be left on. */
                        /* Design note #444: a `private-tile` errand does NOT
                           intercept. The veil has already narrowed the board
                           to one hex, and the click then runs the ordinary
                           tile-picker path -- so a D&H tile lay is the same
                           pipeline as every other lay, at the same terrain
                           cost, rather than a second one to keep in step. */
                        homeStationPlacement &&
                        homeStationPlacement.kind !== "private-tile"
                          ? handleStageFreeStation
                          : tokenTargetMode
                            ? handleTokenHexClick
                            : routeSelectMode
                              ? handleRouteHexClick
                              : previewRotateArmed
                                ? handlePreviewRotate
                                : undefined
                      }
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
                      // Design note #318: the reservation badges read this
                      // roster and clear themselves when a private closes.
                      privateCompanies={gameState?.private_companies}
                      routeOverlays={manualRouteOverlay}
                      // Design note #374: the map both reads and drives the
                      // shared cursor.
                      highlightedTrainIndex={highlightedTrainIndex}
                      onHighlightRoute={setHighlightedTrainIndex}
                      // Design note #224: the Lay Track veil.
                      // Design note #240: one veil, two steps. Track lay
                      // lights what the network can build on; token
                      // targeting lights the cities it may claim.
                      // Design note #269: the tile picker and the token
                      // ring are both anchored to a hex, and the hover
                      // tooltip anchors to the same one. Whichever is open
                      // owns that spot; the tooltip stands down. Mounted
                      // here rather than inferred in the renderer because
                      // both rings are mounted by this file.
                      suppressHoverTooltip={
                        (tileInspectorArmed && radialSelector !== null) || pendingToken !== null
                      }
                      /* ==================================================
                           DESIGN NOTE 377 (shell half): WHOSE VEIL IS IT
                          ==================================================

                          The renderer has a board and no identity, so the
                          question "is the person looking at this the one
                          taking the turn" can only be answered here.

                          `isMyTurn` is exactly that question and already
                          existed for the tab-title flash -- it compares
                          `viewerAddress` against `actingSeatIndex`, which
                          in an Operating Round resolves to the PRESIDENT of
                          the acting corporation rather than to a seat
                          pointer. That is the right identity: the veil
                          marks one corporation's reach, and the player who
                          can act on it is its president.

                          Spread onto whichever focus is live so the token
                          targeting step inherits the same asymmetry without
                          a second flag saying the same thing. */
                      layFocus={
                        /* Design note #440: the home placement's veil takes
                           precedence, and its `dim` is unconditionally
                           `true` rather than `isMyTurn`. The other two ask
                           "is the viewer the acting corporation's
                           president"; this focus only exists because THIS
                           viewer accepted the prompt, so the question is
                           already answered by its presence. Passing
                           `isMyTurn` here would darken the board for a
                           president whose corporation floated outside its
                           own operating turn -- which is most floats. */
                        /* Design note #472: `soleFocusKey` is set while a
                           tile selector is open, which veils every other
                           hex deeply -- including the other legal
                           placements. Spread onto whichever focus is live,
                           the same way `dim` is, so one flag governs all
                           three rather than each growing its own. */
                        homeStationFocus
                          ? { ...homeStationFocus, dim: true, soleFocusKey }
                          : layTrackFocus
                            ? { ...layTrackFocus, dim: isMyTurn, soleFocusKey }
                            : tokenTargetFocus
                              ? { ...tokenTargetFocus, dim: isMyTurn, soleFocusKey }
                              : undefined
                      }
                    />
                  ) : (
                    <StockMarketRenderer
                      marketGrid={marketGrid}
                      // Design note #24 in that file: the par track is fed
                      // by par_value, which the contract sets when the
                      // President's Certificate is bought -- so a parred
                      // but unfloated company appears on the track, which
                      // is the whole point of it.
                      parredCompanies={gameState?.public_companies}
                    />
                  )}
                </div>
                )}

                {/* Automated contextual block underneath the board. */}
                <ContextualSubPanel
                  gameState={gameState}
                  // Design note #405: the footer now renders the ledger's
                  // Player Assets table, which needs the same net-worth
                  // query the ledger runs and a way to name a seat.
                  queryClient={queryClient}
                  contractAddress={CONTRACT_ADDRESS}
                  gameId={gameId}
                  playerLabel={sandbox ? sandboxPlayerLabel : undefined}
                  loading={gameStateLoading}
                  error={gameStateError}
                  // Design note #10 in that file: market price is not on
                  // `GameStateResponse`, so the Market Value column needs
                  // the grid handed to it separately.
                  marketGrid={marketGrid}
                />
              </>
            )}
          </main>
        </>
      )}

      {/* Design note #427: the reference tabs get a way back. Only while
          the viewer is on turn -- see that file for why a permanent banner
          would be worse than none. */}
      {(activeMainTab === "ledger" || activeMainTab === "rules") && (
        <ReturnToTurnBar
          isMyTurn={isMyTurn}
          roundType={gameState?.current_round_type ?? null}
          onReturn={setActiveMainTab}
        />
      )}

      {activeMainTab === "ledger" && (
        <FinancialLedger
          gameState={gameState}
          loading={gameStateLoading}
          error={gameStateError}
          // Player Net Worth (FinancialLedger.tsx design note #4): same
          // live query client/contract/game id every other connected panel
          // in this file already uses.
          queryClient={queryClient}
          contractAddress={CONTRACT_ADDRESS}
          gameId={gameId}
          // Design note #14 in that file: the merged Corporation Assets
          // table's Market Price column. Not on `GameStateResponse`.
          marketGrid={marketGrid}
          // Design note #405: names, not truncated addresses.
          playerLabel={sandbox ? sandboxPlayerLabel : undefined}
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
      {/* Design note #141: the visual cue for a hex that refused the click.
          Amber, not red -- nothing failed and the player did nothing wrong;
          they clicked a hex that simply cannot take a tile. Red is reserved
          for the query error directly above, which IS a fault.

          Reuses the same floating indicator the loading/error states use,
          so the feedback appears in the one place a player is already
          watching after a hex click, rather than in a banner elsewhere on
          the page. Auto-dismisses -- see `handleHexClickQuery`. */}
      {activeMainTab === "map" &&
        hexClickQuery?.status === "blocked" &&
        hexClickQuery.message !== null && (
          <div
            role="status"
            style={{
              ...styles.hexClickIndicator,
              ...styles.hexClickIndicatorBlocked,
              left: hexClickQuery.clientX + 16,
              top: hexClickQuery.clientY + 16,
            }}
          >
            🚫 {hexClickQuery.message}
          </div>
        )}
      {/* Design note #23: `!spectator` is load-bearing, not decorative.
          `TileSelectionPopup` is the SECOND of this app's two gameplay
          dispatch paths -- it calls `useGameSession().execGameplay` itself
          (that component's own design note #1) rather than routing through
          `runGameplayAction`, so the gate inside that function does not
          cover it. Not mounting it is what covers it. */}
      {/* ===================================================================
           DESIGN NOTE 162: THE IN-SITU RADIAL SELECTOR REPLACES THE POPUP
          ===================================================================

          `TileSelectionPopup` -- a ~900px floating card carrying a scrolling
          carousel, era tabs, a rotation panel and a dispatch button -- is no
          longer rendered. It answered "which tiles exist" well and "does
          this tile fit HERE" not at all, because judging fit means looking
          at the hex and its neighbours, and the card covered them.

          The two branches it had (chain-backed `"success"` and local
          `"offline"`) collapse into ONE here. That merge is safe because
          the distinction never lived in the presentation: it is carried by
          `provisional`, which labels the ring, and by `canConfirm`, which
          decides whether a lay can be dispatched at all. Keeping two nearly
          identical JSX blocks was how the old spectator bug got in -- one
          branch grew a `!spectator` guard the other did not need, and the
          asymmetry was invisible.

          The file itself is retained, unrendered, until the radial path has
          been exercised against a live chain. Deleting a component whose
          replacement has only been run offline would leave no way back. */}
      {/* Design note #165/#166: the two halves of the trade engine. The
          sheet is where an offer is composed; the prompt is where it is
          answered. Rendered at the shell level rather than inside the
          action bar because both outlive the panel that opened them -- the
          prompt in particular has to survive the sub-phase advancing. */}
      <ProposePrivatePurchase
        open={privateTradeOpen}
        buyerTicker={
          gameState?.public_companies.find((c) => c.company_id === actingProtocolId)
            ?.ticker ?? "This corporation"
        }
        privates={gameState?.private_companies ?? []}
        labelForAddress={(address) => sandboxPlayerLabel(address) ?? truncateAddress(address)}
        treasury={Number(
          gameState?.public_companies.find((c) => c.company_id === actingProtocolId)
            ?.treasury ?? 0,
        )}
        onPropose={handleProposePrivatePurchase}
        onClose={() => setPrivateTradeOpen(false)}
      />
      {/* ===================================================================
           THE TRAIN CONSENT PROMPT -- design notes #205 and #218
          ===================================================================

          ONE component, TWO sources, and which one is live is decided by
          which deployment this is:

            SANDBOX  `sandboxTrainProposal` -- local state, because there is
                     no chain to record an offer in and no second client to
                     show it to (design note #205).
            ONLINE   `liveTrainOffer` -- derived from the contract's own
                     offer register via `GetTrainOffers`, so the prompt
                     reaches the actual counterparty on their own machine
                     (design note #218).

          They are mutually exclusive by construction: `liveTrainOffer`
          returns `null` in sandbox and `sandboxTrainProposal` is only ever
          set outside it, so this can never show two offers at once. */}
      <TrainTradePrompt
        proposal={liveTrainOffer?.proposal ?? sandboxTrainProposal}
        // Sandbox: one human, one wallet, and the seat switcher already
        // establishes that "who you are" is a local choice there -- so the
        // prompt is answerable by whoever is looking. It still NAMES the
        // seller, so the person clicking Accept is told whose decision they
        // are standing in for.
        //
        // Online: `liveTrainOffer` only exists when the viewer IS the
        // seller's president, so reaching this with a live offer already
        // means the right person is being asked.
        viewerIsSeller={
          liveTrainOffer !== null ||
          sandbox ||
          sandboxTrainProposal?.sellerPresident === viewerAddress
        }
        onAccept={liveTrainOffer ? handleAcceptLiveTrainOffer : handleAcceptSandboxTrainOffer}
        onReject={liveTrainOffer ? handleRejectLiveTrainOffer : handleRejectSandboxTrainOffer}
      />
      <PrivateTradePrompt
        proposal={privateProposal}
        // Design note #2 in that file: sandbox is one human at one wallet,
        // so the prompt is answerable by whoever is looking -- otherwise the
        // only place this flow can run end to end is the one place it
        // cannot be tested. Online, only the actual owner may accept.
        viewerIsOwner={sandbox || privateProposal?.ownerAddress === viewerAddress}
        // Design note #0 in that file: `BuyPrivateCompany` has no accept
        // step, so outside sandbox this is a confirmation and says so.
        consentIsBinding={sandbox}
        onAccept={handleAcceptPrivateOffer}
        onReject={handleRejectPrivateOffer}
      />
      {/* Design note #201: the station token's confirm ring -- the same
          component the tile selector renders through (design note #200), so
          the red X and green check are identical by construction rather
          than by matching two sets of styles. */}
      {activeMainTab === "map" && pendingToken && (
        <RadialTokenConfirm
          anchorOffsetX={pendingToken.offsetX}
          anchorOffsetY={pendingToken.offsetY}
          canvasEl={boardEl}
          hexLabel={pendingToken.hexLabel}
          /* Design note #454: a free placement costs nothing, and the ring
             says so. Quoting the escalating price on a home station would
             be the ring describing a charge that never happens -- the same
             mismatch design note #239 removed from the button. */
          cost={pendingToken.kind === "free" ? 0 : stationTokenCost}
          ticker={
            gameState?.public_companies.find((c) => c.company_id === actingProtocolId)?.ticker ??
            "this corporation"
          }
          /* Design note #462: the actual token, in the ring. Same livery
             and the same computed ink the map draws it with. */
          liveryColor={stationTickerColor(actingProtocolId)}
          liveryInk={bestContrastTextColor(stationTickerColor(actingProtocolId))}
          canConfirm={controlsEnabled}
          confirmDisabledReason="Initialize the session key to place a token."
          onConfirm={handleConfirmTokenPlacement}
          onCancel={handleCancelTokenPlacement}
        />
      )}
      {/* Design note #199, layer 3: not mounted outside the Lay Track step. */}
      {activeMainTab === "map" && tileInspectorArmed && radialSelector && (
        <RadialTileSelector
          anchorOffsetX={radialSelector.offsetX}
          anchorOffsetY={radialSelector.offsetY}
          // Design note #506: sizes the candidates and the ring's clearance.
          hexRadiusPx={radialSelector.hexRadiusPx}
          canvasEl={boardEl}
          hexLabel={radialSelector.hexLabel}
          candidates={radialCandidates}
          selectedTileId={previewTile?.tileId ?? null}
          orientation={previewTile?.orientation ?? 0}
          canConfirm={canLayTileNow}
          confirmDisabledReason={tileLayDisabledReason ?? undefined}
          provisional={radialSelector.provisional}
          // The ring hands back that tile's FIRST legal orientation
          // (design note #173), so the preview never opens on an angle the
          // rotate cycle would then refuse to return to.
          onSelectCandidate={(tileId, orientation) =>
            setPreviewTile({ q: radialSelector.q, r: radialSelector.r, tileId, orientation })
          }
          legalRotationCount={legalRotations.length}
          // Design note #0 in `utils/tokenMigration.ts`: where the tokens
          // already standing on this hex end up. `null` on the ordinary
          // empty hex, which is most of them.
          tokenNote={radialTokenNote}
          // Design note #488b: the caption's picture -- the same migration,
          // drawn on each candidate instead of described.
          stationMarkersFor={radialStationMarkersFor}
          onConfirm={handleConfirmRadialLay}
          onCancel={() => setPreviewTile(null)}
          onDismiss={handleDismissRadial}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Room routing -- design note #1                                      */
/* ------------------------------------------------------------------ */

/** Survives a reload so a player who refreshes mid-game lands back at the
 *  board rather than at the room list. Holds BOTH ids because they address
 *  two different systems and neither can be derived from the other: the
 *  `u64` the contract assigned, and the Firestore room id chat/presence
 *  live under. */
function GameRouter() {
  const [activeGame, setActiveGame] = useState<ActiveGame | null>(readActiveGame);

  useEffect(() => {
    try {
      if (activeGame) window.sessionStorage.setItem(ACTIVE_GAME_STORAGE_KEY, JSON.stringify(activeGame));
      else window.sessionStorage.removeItem(ACTIVE_GAME_STORAGE_KEY);
    } catch {
      /* private browsing -- the game still works, it just is not resumable */
    }
  }, [activeGame]);

  const handleEnterGame = useCallback((gameId: number, roomId: string) => {
    setActiveGame({ gameId, roomId, mode: "play" });
  }, []);

  const handleSpectateGame = useCallback((gameId: number, roomId: string) => {
    setActiveGame({ gameId, roomId, mode: "spectate" });
  }, []);

  /** Design note #24: the escape hatch. Needs no wallet, no contract, no
   *  Firestore room -- which is the entire point, since the absence of all
   *  three is what made the lobby inescapable. */
  const handleEnterSandbox = useCallback(() => {
    setActiveGame({ gameId: SANDBOX_GAME_ID, roomId: SANDBOX_ROOM_ID, mode: "sandbox" });
  }, []);

  const handleLeaveGame = useCallback(() => setActiveGame(null), []);

  if (!activeGame) {
    return (
      <Lobby
        onEnterGame={handleEnterGame}
        onSpectateGame={handleSpectateGame}
        onEnterSandbox={handleEnterSandbox}
      />
    );
  }

  return (
    <AppShell
      // Remounts cleanly on a room change. Without this key, switching
      // rooms would keep the previous room's `actionLog`, ticker scroll
      // position and OR sub-phase cursor -- state that is meaningless in a
      // different game and actively misleading in it.
      //
      // `mode` is part of the key too (design note #24): a viewer who
      // spectates a game and then joins it properly must get a genuinely
      // fresh shell, not one carrying a spectator's accumulated
      // "watching only" log entries and stale derived state.
      key={`${activeGame.gameId}:${activeGame.roomId}:${activeGame.mode}`}
      gameId={activeGame.gameId}
      roomId={activeGame.roomId}
      mode={activeGame.mode}
      onLeaveGame={handleLeaveGame}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Root export -- Provider wrapping, per design note above             */
/* ------------------------------------------------------------------ */

export default function App() {
  return (
    <WalletProvider>
      <GameSessionProvider>
        <GameRouter />
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

/** Design note #36: the four phase tints. Kept beside `styles` rather than
 *  in `palette.ts` because these are chrome colours on the dark top bar,
 *  not card-surface colours -- the palette module is specifically the
 *  light-card system and mixing the two is how a "shared" palette stops
 *  meaning anything. */
/* ==================================================================
 *  DESIGN NOTE 324: THE PHASE BADGE IS A LABEL, NOT AN ALERT
 * ==================================================================
 *
 * REPORTED: make the base "Phase: Yellow/Green/Brown" badge neutral so only
 * upcoming phase-change alerts use high-contrast warning colours.
 *
 * The badge was tinted to match the era -- amber in Yellow, green in Green,
 * brown in Brown -- which reads as a colour-coded STATUS on a bar where
 * amber and red already mean "act now": `phaseShiftBadgeWarn` and
 * `phaseShiftBadgeCritical` sit inches away in the same rail, in the same
 * pill shape, in the same amber. So the permanent label and the two-buys
 * warning were competing at the same volume, and the warning is the one
 * that has to win: it appears for exactly the few purchases before a rust,
 * and it is the only badge on the bar a player must react to.
 *
 * Neutral slate for all three. The era is still named in the text, which is
 * what a label is for, and the ERA'S OWN COLOUR still appears everywhere it
 * is load-bearing -- the tile catalog, the sub-phase stepper, the board
 * tint. This badge was the one place the colour carried no information the
 * word did not already carry.
 *
 * One record per tint rather than a single style, so the shape is still
 * there if a future pass wants a subtle era cue back -- e.g. a left border
 * -- without re-tinting the whole pill.
 */