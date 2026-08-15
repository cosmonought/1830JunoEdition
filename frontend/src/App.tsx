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

import {
  chainConfigError,
  formatNativeAmount,
  JUNO_RPC_ENDPOINT,
  NATIVE_DENOM_DISPLAY,
} from "./config";
import { GameSessionProvider, useGameSession } from "./context/GameSessionContext";
import HexGridRenderer, {
  type RouteOverlay,
  type MapGridResponse,
  type HexClickQueryState,
} from "./components/HexGridRenderer";
import { liveEdgesForHex } from "./components/hexGeometry";
import { assignRouteSet, bridgeWaypoints } from "./utils/routeAutoTrace";
import { layableHexes, reachableNetwork } from "./utils/trackReach";
import { countPhrase, describeGameplayAction } from "./utils/actionLog";
import { STATIC_BOARD_HEXES } from "./components/hexBoardData";
import {
  bestContrastTextColor,
  glowColorFor,
  stationTickerColor,
} from "./components/hexContractTypes";
import { TrainChips } from "./components/TrainBadges";
import PrivatePowerPanel, { type PrivateAbility } from "./components/PrivatePowerPanel";
import type { PrivateCompanyState } from "./utils/gameState";
import { RoutePlannerPanel, RouteModeToggle } from "./components/RoutePlannerPanel";
import type { RouteBuildMode, TrainRouteDraft } from "./components/RoutePlannerPanel";
import StationTokenRow from "./components/StationTokenRow";
import {
  evaluateStationPlacement,
  nextStationTokenCost,
  placeableStationHexes,
  stationTokenSlots,
  type StationTokenSlot,
} from "./utils/stationTokens";
import { corporationFullName } from "./utils/corporationNames";
import StockMarketRenderer, {
  marketCellForPrice,
  projectDividendCellMove,
  projectShareSaleMove,
  marketZoneForPrice,
  marketZoneTextColor,
  marketZoneTooltip,
  projectDividendMove,
  type MarketProjection,
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
import TrainPurchasePanel, {
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
  type TileColor,
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
import { CONTROL_PADDING, FONT_SIZE, LINE_HEIGHT } from "./styles/typography";
import {
  ALERT_CRITICAL_BG,
  ALERT_CRITICAL_BORDER,
  ALERT_CRITICAL_INK,
  ALERT_WARN_BG,
  ALERT_WARN_BORDER,
  ALERT_WARN_INK,
  TURN_PULSE_INK_RGB,
} from "./styles/palette";
import {
  depotInventory,
  derivePhase,
  phaseAlertLevel,
  rustOutlook,
  type GamePhase,
  type PhaseTint,
  type TierRustOutlook,
  type TrainTier,
} from "./utils/gamePhase";
import type { TileColorTier } from "./components/hexTileCatalog";
import { filterSandboxPlacements, isTokenableHex } from "./components/sandboxTileLegality";
import { describeTokenMigration, previewTokenMigration } from "./utils/tokenMigration";
import type { LegalTilePlacement } from "./components/hexContractTypes";
import {
  OperatingSubPhaseStepper,
  OPERATING_SUB_PHASE_LABELS,
  OPERATING_SUB_PHASE_ORDER,
  initialOrSubPhase,
  visibleSubPhases,
  type OperatingSubPhase,
} from "./components/OperatingSubPhaseStepper";
import { useDocumentTitleFlash } from "./utils/turnAlert";
import {
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
import type { GameplayExecuteMsg, RouteWaypointDto } from "./utils/sessionKey";
import {
  applySandboxAction,
  applySandboxMarketAction,
  applySandboxWaterfallAction,
  applySandboxLayTile,
  isRouteTerminusHex,
  sandboxRouteBreakdown,
  SANDBOX_NOMINAL_TOKEN_COST,
} from "./utils/sandboxSession";
import SandboxToolbar from "./components/SandboxToolbar";

// Step 4: Firebase Real-Time Integration -- see design notes #1 and #22.
import Lobby from "./components/Lobby";
import TutorialModal, {
  TutorialLibrary,
  OPERATING_ROUND_TUTORIAL,
  STOCK_MARKET_TUTORIAL,
  STOCK_ROUND_TUTORIAL,
  WATERFALL_AUCTION_TUTORIAL,
} from "./components/TutorialModal";
import { ConnectWalletButton } from "./components/ConnectWalletButton";
import { useFirestoreChat } from "./components/ChatBox";
// NOT importing `truncateAddress` from `utils/lobby` -- this file already
// has its own local one (below, with configurable lead/trail lengths) and
// importing the second would be a name collision. Two truncators is one too
// many, but unifying them is a separate tidy-up, not this pass's business.
import { loadDisplayName, usePresenceHeartbeat } from "./utils/lobby";

/* ------------------------------------------------------------------ */
/* Placeholder room state -- see design note #1                       */
/* ------------------------------------------------------------------ */

/** Room id for the two MOCK DISPLAY GRIDS below, and nothing else.
 *
 *  Design note #1's `MOCK_GAME_ID` is GONE -- `AppShell` now receives a real
 *  `gameId` prop from `GameRouter`, sourced from the contract's own
 *  `CreateGameRoom` response (see `Lobby.tsx` design note #2). This constant
 *  survives only because `MOCK_MAP_GRID`/`MOCK_MARKET_GRID` are module-scope
 *  literals that have to put SOMETHING in their `game_id` field, and design
 *  note #2 above is explicit that those two are illustrative data never
 *  produced by a live query. It is deliberately NOT the room anything talks
 *  to. */
const MOCK_GRID_GAME_ID = 1;
const MOCK_BUY_STOCK_PAR_VALUE = "100"; // top of the standard 1830 par ladder
/* `MOCK_DECLARE_DIVIDENDS_REVENUE` is GONE -- design note #198.
   It was `"0"`, dispatched on every dividend declaration regardless of what
   the corporation had just earned, while the panel beside the buttons showed
   the real figure. Deleted rather than left unused so nothing can quietly
   start sending a constant again; `handleDeclareDividendsChoice` reads
   `last_route_revenue` from the corporation being acted for. */
// Same placeholder rationale as design note #1/#4 above: there's no
// company-selector UI yet, so the Interactive Tile-Selection Popup's
// GetLegalTilePlacements/LayTile calls -- and now the Operating-Round-scoped
// mock action bar buttons too -- need SOME protocol_id to target. B&O
// (protocol_id 4) is used here specifically because it's the simplest
// "always floatable" company in the Rust test suite (src/tests.rs), not
// because of any in-game significance -- swap for real company-selection
// state once that flow exists, same as MOCK_BUY_STOCK_PROTOCOL_ID.
/** Design note #250: one sentence, three refusal sites. Stated once so the
 *  builder, the auto-drafter and the dispatch cannot describe the same
 *  situation three slightly different ways. */
const NO_TRAIN_ROUTE_REASON =
  "This corporation owns no trains, so it has no route to run. Buy a train in the Buy Trains step first.";

const MOCK_LAY_TILE_PROTOCOL_ID = 4; // B&O, per public_company::CORE_PUBLIC_COMPANIES

/** Hand-kept mirror of `hardware::TRAIN_CATALOG` (`(model_type, baseline
 *  cost in, max route distance, bank quantity)`) -- same convention as
 *  `HexGridRenderer.tsx`'s `TILE_CATALOG` mirror. Purely a DISPLAY source
 *  for the Operating Round Phase 4 "active engines" marketplace tray (item
 *  2/Phase 4 below): `BuyHardwareFromPool` itself takes no model-selection
 *  parameter yet (see `hardware.rs`'s own module doc comment #2, "No model
 *  selection" -- it auto-picks from the pool), so selecting a tile here
 *  only drives which model is highlighted/labeled in the tray, not which
 *  model actually gets purchased. Keep this in exact sync with the Rust
 *  array if it ever changes. */
/** Design note #285: the cap for a train this build's catalog does not
 *  know. The smallest real train in 1830, so an unknown model is refused
 *  where a 2-train would be rather than being uncapped. */
const SMALLEST_TRAIN_CAPACITY = 2;

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

/* `OperatingSubPhase` and its ordered label table MOVED to
   `components/OperatingSubPhaseStepper.tsx` (imported above).

   They were declared here and the stepper needed all three -- the union,
   the order and the labels. Re-declaring them there would have created the
   second copy of a sequence the contract gates on
   (`or_phase::OR_PHASE_ORDER`), which is the one thing this ordering must
   not have. The stepper owns them now and this file imports; nothing about
   the values changed.

   `RulesReference.tsx` still keeps its own independent copy, deliberately
   -- that file takes no game-state coupling at all (its design note #112). */

/* ------------------------------------------------------------------ */
/* Mock map preview data -- see design note #2                        */
/* ------------------------------------------------------------------ */

// design note #15: the three landmark entries this array used to carry
// (New York/Boston/Baltimore, each pre-seeded with `tile_id: 10`) are
// REMOVED -- see that note for the full bug this caused and why an empty
// `tiles: []` is actually the MORE accurate mock of a freshly-created real
// game, not less.
const MOCK_MAP_GRID: MapGridResponse = {
  game_id: MOCK_GRID_GAME_ID,
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
  game_id: MOCK_GRID_GAME_ID,
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

// Design note #18/item 3's `nextChatMessageId` counter is REMOVED (design
// note #22). Chat message ids are now Firestore document ids -- globally
// unique and identical in every player's browser, which a per-client
// counter could never be. See `utils/feed.ts`'s `ChatMessage.id` for why
// that field was widened to `string | number` rather than the id being
// hashed back down into a number.

/* ------------------------------------------------------------------ */
/* Dashboard Control Bar                                              */
/* ------------------------------------------------------------------ */

/* ==================================================================
 *  DESIGN NOTE 34: ONE TOP BAR
 * ==================================================================
 *
 * There were two full-width headers stacked above the tab bar: this one
 * (brand, Master Wallet, Session Key, JUNO balance, Cash) and the room
 * strip below it (game id, room id, Back to lobby). Three rows of chrome
 * before a single hex of the board -- and the two headers were not even
 * different subjects, both being "what am I connected to".
 *
 * They are one slim strip now: identity and room context on the left,
 * connection controls pushed right, `Connect Keplr` last. The room content
 * arrives as `roomContext` rather than being rebuilt here, because the
 * sandbox phase switcher and the spectator badge need state that lives in
 * `AppShell`; passing a node keeps this component ignorant of game state
 * it has no other reason to know about.
 *
 * WHAT WAS DELETED, AND WHY IT WAS SAFE:
 *
 *   - THE CASH READOUT. In-game cash belongs to the Game Ledger and the
 *     Player Index, not to the row that also shows a crypto balance --
 *     that adjacency was the exact confusion the old F-3 note worried
 *     about, and the honest fix is not two visual treatments of two kinds
 *     of money side by side, it is not putting them side by side.
 *   - THE FIELD LABELS ("Master Wallet", "Session Key", "Wallet"). A
 *     truncated bech32 address next to a status dot does not need a
 *     caption; the tooltips carry the full values.
 *   - THE ALWAYS-VISIBLE "Initialize Session Key" BUTTON. It now appears
 *     only while it is actionable -- wallet connected, session not ready.
 *     Once ready it collapses to a dot, because a button that has already
 *     been pressed and cannot usefully be pressed again is just width.
 *
 * The session key is NOT dropped, only condensed: it is what authorises
 * gameplay transactions, so its state stays visible at all times, and its
 * error still renders inline. */
/* Design note #40: the phase badge is NOT in this bar.
 *
 * It was, briefly, sitting between the brand and the room context. That was
 * the wrong slot for a measurable reason rather than an aesthetic one: this
 * header is a single `flex` row, and adding two more pills to it pushed the
 * wallet cluster -- balance, address, Connect -- onto a second line, which
 * undid the entire point of design note #34's consolidation.
 *
 * The badge now lives at the far right of the Contextual Action Bar, which
 * is also the better home on the merits. The action bar already says WHAT
 * ROUND it is; the phase says which trains and tiles that round can use.
 * The two belong on the same strip, and that strip has spare width because
 * its buttons are left-aligned. */
function TopBar({
  roomContext,
  onLeaveGame,
}: {
  /** Room identity / sandbox controls, owned by `AppShell` -- see design
   *  note #34 for why this is a node rather than a pile of props. */
  roomContext?: React.ReactNode;
  onLeaveGame?: () => void;
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

  // Only offer the session key when pressing it would do something. See
  // design note #34 -- the disabled-forever button was pure width.
  const canInitSession = wallet.status === "connected" && session.sessionStatus !== "ready";

  return (
    <header style={styles.topBar}>
      {/* Inline styles cannot express `:hover`; see design note #46. */}
      <style>{NETA_CREDIT_CSS}</style>
      <span style={styles.topBarBrand}>1830: Juno Edition</span>

      {/* Design note #47: the Neta DAO credit.
          Sits with the BRAND, not with the wallet cluster. It is an
          attribution, so it belongs next to the thing being attributed --
          and the right-hand group is the one that already wraps first when
          the bar gets tight (design note #34). Parking a decorative link
          there would push a functional control onto a second line.

          `flexShrink: 0` plus `nowrap` so it never becomes the thing that
          breaks the row, and `rel="noopener noreferrer"` because
          `target="_blank"` without it hands the new tab a `window.opener`
          handle back into this app. */}
      <a
        href="https://netadao.org"
        target="_blank"
        rel="noopener noreferrer"
        className="neta-credit"
        style={styles.netaCredit}
        title="Neta DAO -- opens netadao.org in a new tab"
      >
        Powered by Neta DAO
      </a>

      {roomContext}

      {/* Everything after this spacer is pinned right. */}
      <span style={styles.topBarSpacer} />

      {configError && (
        <span style={styles.offlineBadge} title={configError}>
          {/* The full message is long and names a rebuild requirement; the
              badge shows the actionable half and the tooltip carries the
              rest, so the bar never wraps. */}
          Offline -- {firstMissingEnvVar(configError) ?? "chain not configured"}
        </span>
      )}

      {wallet.error && (
        <span style={styles.topBarError} title={wallet.error}>
          {wallet.error}
        </span>
      )}
      {session.sessionError && (
        <span style={styles.topBarError} title={session.sessionError}>
          {session.sessionError}
        </span>
      )}

      {/* Session key: a dot plus, when it would do something, a button. */}
      <span
        style={{ ...styles.topBarDot, ...statusDotColor(session.sessionStatus) }}
        title={`Session key: ${sessionStatusLabel[session.sessionStatus]}${
          session.sessionAddress ? ` (${session.sessionAddress})` : ""
        }`}
        aria-label={`Session key ${sessionStatusLabel[session.sessionStatus]}`}
      />
      {canInitSession && (
        <button
          type="button"
          style={styles.topBarButton}
          onClick={session.initializeSessionKey}
          disabled={session.sessionStatus === "initializing"}
          title="Authorise a session key so gameplay actions do not each need a wallet popup."
        >
          {session.sessionStatus === "initializing" ? "Initializing..." : "Session Key"}
        </button>
      )}

      {wallet.status === "connected" && (
        <>
          <span
            style={styles.nativeBalancePill}
            title={nativeBalanceTitle(wallet.nativeBalance)}
          >
            <span style={styles.nativeBalanceAmount}>
              {wallet.nativeBalance ? formatNativeAmount(wallet.nativeBalance.amount) : "--"}
            </span>
            <span style={styles.nativeBalanceDenom}>{NATIVE_DENOM_DISPLAY}</span>
          </span>
          <span style={styles.topBarAddress} title={wallet.address ?? undefined}>
            {truncateAddress(wallet.address)}
          </span>
        </>
      )}

      <span
        style={{ ...styles.topBarDot, ...statusDotColor(wallet.status) }}
        title={`Wallet: ${walletStatusLabel[wallet.status]}`}
        aria-label={`Wallet ${walletStatusLabel[wallet.status]}`}
      />

      {wallet.status === "connected" ? (
        <button type="button" style={styles.topBarButton} onClick={wallet.disconnect}>
          Disconnect
        </button>
      ) : (
        // Design note #34 + `ConnectWalletButton`'s own design note #0: the
        // burner-wallet recommendation ships WITH the button, so no entry
        // point can skip it.
        <ConnectWalletButton buttonStyle={styles.topBarConnectButton} />
      )}

      {onLeaveGame && (
        <button type="button" style={styles.topBarButton} onClick={onLeaveGame}>
          &larr; Lobby
        </button>
      )}
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

/** Design note #34: the status PILLS became status DOTS, so this returns a
 *  fill only -- there is no longer any text sitting on the colour to need a
 *  matching foreground. Same four states, same meanings. */
function statusDotColor(
  status: "disconnected" | "connecting" | "connected" | "error"
    | "uninitialized" | "initializing" | "ready",
): React.CSSProperties {
  switch (status) {
    case "connected":
    case "ready":
      return { backgroundColor: "#2f9e57" };
    case "connecting":
    case "initializing":
      return { backgroundColor: "#c9a94c" };
    case "error":
      return { backgroundColor: "#c05050" };
    default:
      return { backgroundColor: "#4a505e" };
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
  /** Step 4.5 Batch 3, item 1: which station on this hex the stop is.
   *
   *  `undefined` -- the normal case -- means "this hex has one stop, or
   *  none": a town, plain connector track, or a single-city tile. Only a
   *  genuinely multi-city hex (New York's #62, the OO tiles) needs it, and
   *  the map has no two-city picker yet, so nothing sets it today. It is
   *  carried on the point rather than bolted on at dispatch time so that
   *  `routePointsToWaypoints` stays a pure rename of fields, and so adding
   *  that picker later is a change to ONE click handler rather than to the
   *  payload shape. */
  cityNode?: number;
}

/** Converts the map's in-progress route into the contract's
 *  `RunManualRoute` payload -- Step 4.5 Batch 3, item 1.
 *
 *  This is the single place the UI's route representation becomes the wire
 *  format, so the deprecated `hex_path: string[]` shape cannot survive
 *  anywhere by accident. `city_node` is omitted entirely (rather than sent
 *  as `null`) when a point names no station: the field is `Option<usize>`
 *  with `#[serde(default)]`-style optionality on the Rust side, and an
 *  absent key is the cleaner encoding of "unspecified". */
function routePointsToWaypoints(points: readonly RoutePoint[]): RouteWaypointDto[] {
  return points.map((point) =>
    point.cityNode === undefined
      ? { hex: point.hexLabel }
      : { hex: point.hexLabel, city_node: point.cityNode },
  );
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




/* ===================================================================
 *  DESIGN NOTE 197: THE MARKET MOVE LINE
 * ===================================================================
 *
 * Two changes, and the second is a rules affordance rather than styling.
 *
 * FORMAT. It read "Market move: ↗ to $82", which states the destination and
 * hides the departure -- the one comparison the dividend decision turns on.
 * It now reads "Market move: $76 ⬆ $82": both prices, the arrow between
 * them, in the direction the token travels.
 *
 * COLOUR AND TOOLTIP. A price that lands in a Yellow, Orange or Brown cell
 * carries real rule consequences -- certificate-limit exemption, the 60%
 * ownership cap, multi-share bank-pool buys -- and the chart has always
 * shown that by tinting the cell. A player reading this panel is looking at
 * a NUMBER, not at the chart, so the fact was invisible exactly when it
 * mattered: paying out to step from a Normal cell into the Yellow zone is a
 * different decision from stepping to any other cell, and nothing said so.
 *
 * Each price is therefore tinted with its own zone's ink and carries that
 * zone's rule as a tooltip. `marketZoneForPrice` is the same lookup the
 * chart colours itself from, so this panel and the board can never disagree
 * about which prices are Brown -- see design note #196 for why the flat text
 * ink is a separate export from the cell gradient.
 *
 * THE TWO PRICES ARE TINTED INDEPENDENTLY, which is the whole point: the
 * interesting case is precisely the one where they differ.
 */
function ZonedPrice({ price }: { price: number | null }) {
  if (price === null) return <>--</>;
  const zone = marketZoneForPrice(price);
  const color = marketZoneTextColor(zone);
  const tooltip = marketZoneTooltip(zone);
  return (
    <span
      style={color ? { color, fontWeight: 700, cursor: "help" } : undefined}
      title={tooltip ?? undefined}
    >
      ${price}
    </span>
  );
}

function MarketMoveLine({
  currentPrice,
  projection,
  direction,
}: {
  currentPrice: number | null;
  projection: MarketProjection | null;
  /** Which way the token travels: paying out steps right, withholding left. */
  direction: "pay" | "withhold";
}) {
  /* ================================================================
   *  DESIGN NOTE 214: THE ARROW CARRIES THE MEANING
   * ================================================================
   *
   * The arrows were a vertical pair -- U+2B06 UP and U+2B07 DOWN -- in the
   * same neutral grey as the surrounding text. Two problems, and the second
   * is the one that mattered.
   *
   * DIRECTIONALITY. 1830's chart moves a token ALONG ITS ROW: paying out
   * steps right, withholding steps left. A purely vertical arrow describes
   * neither of those, and on a chart where vertical movement is what
   * SELLING does, an up arrow is actively the wrong gesture. The diagonals
   * (U+2197 up-right, U+2198 down-right) read as "onward and better" versus
   * "onward and worse", which is what the two choices actually are.
   *
   * COLOUR. Both arrows were grey, so at a glance the two columns of this
   * panel looked identical and the player had to read the prices to tell
   * which was which. Green for the rise and red for the fall is the one
   * colour convention every player already has, and it lets the choice be
   * made peripherally.
   *
   * THE PRICES KEEP THEIR OWN COLOURS. Design note #197 tints each price by
   * its market ZONE -- a rules fact -- and that must not be overwritten by
   * the direction, which is a different fact about a different thing. So the
   * arrow is the only glyph the direction colours, and it is deliberately
   * heavier than the text around it so it wins the glance without needing
   * the prices to shout.
   */
  const rising = direction === "pay";
  const arrow = rising ? "↗" : "↘";

  // No chart position at all -- an unfloated corporation, or a price the
  // grid has no cell for. Saying so beats printing an arrow between two
  // dashes, which would read as a move to nowhere.
  if (projection === null || currentPrice === null) {
    return (
      <span style={styles.dividendMove}>
        Market move: not on the market chart
      </span>
    );
  }

  return (
    <span style={styles.dividendMove}>
      Market move: <ZonedPrice price={currentPrice} />{" "}
      <span
        style={{
          ...styles.dividendMoveArrow,
          ...(rising ? styles.dividendMoveArrowUp : styles.dividendMoveArrowDown),
        }}
        // The arrow is decoration for a sighted reader and the whole
        // direction for everyone else, so it is labelled rather than hidden.
        role="img"
        aria-label={rising ? "rises to" : "falls to"}
      >
        {arrow}
      </span>{" "}
      <ZonedPrice price={projection.price} />
      {/* The edge of the chart. The format is unchanged -- both prices and
          the arrow are still there, and they are simply equal -- with the
          reason appended, because a line reading "$100 ↗ $100" with no
          explanation looks like a bug rather than a ceiling. */}
      {!projection.moves && (
        <span style={styles.dividendMoveNote}>
          {rising ? " (already at the top of its row)" : " (already at the bottom of its row)"}
        </span>
      )}
    </span>
  );
}

/* ==================================================================
 *  DESIGN NOTE 298: WHAT A PINNED BAR IS ALLOWED TO KEEP
 * ==================================================================
 *
 * A sticky bar costs the map its height for the whole scroll, so the
 * pinned form has to earn every row it occupies. The rule applied is: keep
 * what a player needs WHILE LOOKING AT THE BOARD, drop what they only need
 * when deciding what to do next.
 *
 *   KEPT   the phase badge, the acting corporation, its treasury and train
 *          limit, and every action button. These are the inputs to "can I
 *          click that hex", which is the question being asked while the map
 *          is on screen.
 *   DROPPED the station-token row, the president's name, the train chips
 *          and the sub-phase stepper. All are orientation -- they answer
 *          "where am I in the turn", which the player has already answered
 *          by the time they are scrolling the map.
 *
 * The stepper is the one worth defending: it is a progress indicator, and a
 * progress indicator that is always visible stops being read. It comes back
 * the moment the bar unsticks.
 */
function useCondensedOnScroll(threshold = 24): boolean {
  const [condensed, setCondensed] = React.useState(false);
  React.useEffect(() => {
    if (typeof window === "undefined") return undefined;
    /* Read on a rAF rather than on every scroll event: this flips one
       boolean, and re-rendering the action bar on every pixel of a wheel
       gesture is the classic scroll-listener jank. */
    let queued = false;
    const onScroll = () => {
      if (queued) return;
      queued = true;
      window.requestAnimationFrame(() => {
        queued = false;
        setCondensed(window.scrollY > threshold);
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [threshold]);
  return condensed;
}

function ContextualActionBar({
  roundType,
  orSubPhase,
  sessionReady,
  onPassTurn,
  passDisabledReason,
  onPlaceStationTokenHint,
  stationTokenCost,
  activeCorporation,
  tokenTargetMode,
  setTokenTargetMode,
  onSkipSubPhase,
  onOpenPrivateTrade,
  ownsAnyTrain,
  mustBuyTrain,
  privateCompanies,
  privatePowerViewer,
  sandboxMode,
  usedPrivateAbilities,
  onUsePrivateAbility,
  onRunTrains,
  onPayDividends,
  onWithholdRevenue,
  dividendRevenue,
  dividendRevenueIsThisTurn,
  dividendPerShare,
  dividendPayouts,
  rustOutlookForBar,
  dividendPrice,
  payProjection,
  withholdProjection,
  selectedHardwareModel,
  onEndOperatingTurn,
  onUndoLastAction,
  routeBuildMode,
  onSelectRouteBuildMode,
  onSelectRouteTrain,
  trainDrafts,
  activeTrainIndex,
  routeFeedback,
  onClearRoute,
  currentGlobalEra,
  isMyTurn,
  phase,
}: {
  roundType: RoundType | null;
  /** Only meaningful while `roundType === "OperatingRound"` -- see design
   *  note #10/item 2. */
  orSubPhase: OperatingSubPhase;
  sessionReady: boolean;
  onPassTurn: () => void;
  /** Design note #31: why passing is currently illegal, or `null`. The
   *  waterfall forbids it while no private holds a standing bid
   *  (`waterfall.rs` doc comment #1) -- a fact only the caller has. */
  passDisabledReason: string | null;
  onPlaceStationTokenHint: () => void;
  /** Design note #181: what a token costs this corporation, for the button
   *  label. A number rather than a formatted string so the caller cannot
   *  quietly change the currency here. */
  stationTokenCost: number;
  /** Design note #228: who is acting, and the three figures that gate what
   *  they can do this turn. `null` before the first `GetGameState` resolves
   *  or when the operating queue names a company this build does not know --
   *  the card then says so rather than rendering blanks. */
  activeCorporation: {
    companyId: number;
    ticker: string;
    fullName: string | null;
    presidentLabel: string | null;
    treasury: number;
    /** Design note #237: the whole allowance, one entry per token, with its
     *  own escalating price. Replaces the `stationsLeft`/`stationLimit`
     *  pair, which could only express a fraction. */
    stationSlots: readonly StationTokenSlot[];
    trains: readonly string[];
  } | null;
  /** Design note #159: whether station-token targeting is armed, and the
   *  setter behind the banner's own Cancel. Passed rather than owned here
   *  because the CANVAS is the other half of this mode and lives in the
   *  parent. */
  tokenTargetMode: boolean;
  setTokenTargetMode: (on: boolean) => void;
  /** Design note #144: dispatches the real `AdvanceOperatingSubPhase`
   *  message. Every skip is now an on-chain, replayable event -- the old
   *  client-only `setOrSubPhase` calls advanced the UI while the contract's
   *  cursor stayed put, which under G-14 enforcement would have desynced the
   *  bar from what the chain would actually accept. */
  onSkipSubPhase: () => void;
  /** Opens the propose-purchase sheet -- design note #165. */
  onOpenPrivateTrade: () => void;
  /** Drives the Routes skip button's disabled state -- see its `title`. */
  ownsAnyTrain: boolean;
  /** Design note #293b: the corporation's roster is REPORTED and EMPTY, so
   *  1830's mandatory purchase applies. Distinct from `!ownsAnyTrain`,
   *  which is also true when the chain simply did not say. */
  mustBuyTrain: boolean;
  /** Design note #0 in `PrivatePowerPanel.tsx`. */
  privateCompanies: readonly PrivateCompanyState[];
  privatePowerViewer: string | null;
  sandboxMode: boolean;
  usedPrivateAbilities: ReadonlySet<number>;
  onUsePrivateAbility: (ability: PrivateAbility) => void;
  onRunTrains: () => void;
  onPayDividends: () => void;
  onWithholdRevenue: () => void;
  /** Design note #188: the acting corporation's last route revenue, and the
   *  per-10%-share split of it. */
  dividendRevenue: number;
  /** Design note #278: whether `dividendRevenue` was earned on THIS turn.
   *  `false` only when this corporation is known to have skipped the Routes
   *  step, which makes a carried-over figure from a previous Operating
   *  Round non-binding. */
  dividendRevenueIsThisTurn: boolean;
  dividendPerShare: number;
  /** Who receives what, already resolved to display names. */
  dividendPayouts: ReadonlyArray<{ holder: string; percentage: number; amount: number }>;
  /** Design note #259: per-tier rust countdown, so the bar's train chips
   *  read identically to the Round Detail table's. */
  rustOutlookForBar: Readonly<Record<TrainTier, TierRustOutlook>> | null;
  /** Design note #197: the price the token sits on NOW. The market move line
   *  states both ends of the step, and this is the departure. `null` for a
   *  corporation with no position on the chart. */
  dividendPrice: number | null;
  /** Where the stock token lands under each choice, or `null` when the
   *  current price is not on the chart. */
  payProjection: MarketProjection | null;
  withholdProjection: MarketProjection | null;
  selectedHardwareModel: string;
  onEndOperatingTurn: () => void;
  onUndoLastAction: () => void;
  /** Design note #266: which drafting tool built the path on screen. The
   *  old `routeSelectMode` boolean plus a separate Auto Route ACTION became
   *  one two-position mode -- see `RoutePlannerPanel`'s design note #1. */
  routeBuildMode: RouteBuildMode;
  onSelectRouteBuildMode: (mode: RouteBuildMode) => void;
  onSelectRouteTrain: (trainIndex: number) => void;
  /** Design note #275: one priced draft per owned train, INCLUDING
   *  duplicate models -- three 3-trains are three entries. */
  trainDrafts: readonly TrainRouteDraft[];
  /** Which train the map's clicks are drafting for. */
  activeTrainIndex: number;
  /** Design note #266/#4: why the builder refused the last map click, or
   *  `null`. Distinct from the standing legality reasons the panel derives
   *  for itself -- only the click handler knows this one. */
  routeFeedback: string | null;
  onClearRoute: (trainIndex: number | null) => void;
  /** Buy Private Company Action Tray -- design note #14. Already filtered
   *  down to what `activePlayerAddress` actually still owns and could sell
   *  (`playerSellablePrivateCompanies`), not the full room-wide list. */
  currentGlobalEra: TileColor | null;
  /** Active Player Turn Notifications -- design note #18/item 4. Applies
   *  the shared `app-turn-pulse-glow` keyframe (see `styles.appRoot`'s own
   *  JSX call site for where that `<style>` tag is injected) to this bar's
   *  own outer wrapper. */
  isMyTurn: boolean;
  /** Derived phase (`utils/gamePhase.ts`) for the far-right badge -- see
   *  design note #40 for why it moved here from the header. */
  phase?: GamePhase | null;
}) {
  // Design note #7 (`gamePhase.ts`): the ONE severity decision, shared with
  // the train chips. Computed here rather than inline in the JSX because
  // both the badge's style and its wording branch on it.
  const phaseAlert = phaseAlertLevel(phase ?? null);
  /** Design note #297/#298: pinned to the top, so the bar sheds its
   *  orientation rows and keeps only what is needed while reading the map. */
  const condensed = useCondensedOnScroll();

  /* Design note #236: the acting corporation's own colours, resolved once.
   *
   * `bestContrastTextColor` is the same per-fill choice the map's station
   * tokens make for their acronyms, so this bar and the tokens it describes
   * agree about what is legible on that brand colour -- rather than this
   * asserting white and being wrong on C&O's orange.
   *
   * SECONDARY TEXT IS THE SAME INK AT REDUCED ALPHA, never a fixed grey. A
   * grey that reads as "quieter" on PRR's dark red is nearly invisible on
   * C&O's orange; alpha over the actual background holds its relationship to
   * whatever is behind it.
   *
   * NO CORPORATION -> the neutral dark this bar always had. That state is
   * reachable before the first `GetGameState` resolves, and colouring it
   * from `stationTickerColor(0)`'s fallback grey would dress an empty bar as
   * though a company were acting. */
  const corporationBarInk = React.useMemo(() => {
    if (!activeCorporation) {
      return {
        background: "#171c28",
        border: "#2b3242",
        ink: "#eaf2ff",
        inkMuted: "rgba(234, 242, 255, 0.66)",
      };
    }
    const background = stationTickerColor(activeCorporation.companyId);
    const ink = bestContrastTextColor(background);
    const light = ink === "#FFFFFF";
    return {
      background,
      // A translucent black edge darkens any hue by the same amount, so one
      // rule gives every corporation a border rather than eight hand-picked
      // shades that would drift from the palette they are derived from.
      border: "rgba(0, 0, 0, 0.35)",
      ink,
      inkMuted: light ? "rgba(255, 255, 255, 0.74)" : "rgba(0, 0, 0, 0.66)",
    };
  }, [activeCorporation]);

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
            onClick: onOpenPrivateTrade,
            title: "Select a private company below to purchase it into this corporation's treasury.",
          },
        ];
        break;
      case "Tokens":
        contextualButtons = [
          {
            key: "station",
            // Design note #181: the PRICE is on the button. A token costs
            // real treasury and the amount varies by corporation, so
            // "Place Station Token" asked the player to commit to a spend
            // whose size the UI knew and did not say.
            label: `Place Station Token for $${stationTokenCost}`,
            onClick: onPlaceStationTokenHint,
            title: `Costs $${stationTokenCost} from this corporation's treasury. Click a city hex on the Rail Map to place it.`,
          },
        ];
        break;
      case "Routes":
        /* Design note #142: its own phase. Running trains is what PRODUCES
           the revenue figure; the dividend decision below is what is done
           with it.

           NO CONTEXTUAL BUTTON -- design note #266. "Run Selected Route"
           used to sit here, in the centre column, ABOVE the panel showing
           the route it would submit and the readout saying whether that
           route was legal. It is now the bottom row of `RoutePlannerPanel`,
           directly under the path it runs and carrying the amount it pays.
           Leaving a copy here would be a second control for one action --
           and the vaguer of the two, since only the panel's copy knows the
           figure. */
        contextualButtons = [];
        break;
      case "Dividends":
        contextualButtons = [
          {
            key: "pay-dividends",
            // Design note #188: the per-share figure is the number the
            // decision turns on, and it was the one thing the button did
            // not say. 1830 splits revenue ten ways -- one share is 10% --
            // so a $180 route pays $18 a share.
            label: `Pay Dividends ($${dividendPerShare} per share)`,
            onClick: onPayDividends,
            title: `Splits $${dividendRevenue} between every shareholder at $${dividendPerShare} per 10% share.`,
          },
          {
            key: "withhold-revenue",
            label: "Withhold to Corporate Treasury",
            onClick: onWithholdRevenue,
            title: `Keeps all $${dividendRevenue} in the corporation's treasury. Shareholders receive nothing.`,
          },
        ];
        break;
      case "Hardware":
        contextualButtons = [
          // Both ways of acquiring a train live in `TrainPurchasePanel`
          // (design note #203), which is the only place that knows what the
          // depot will sell and which corporations hold what. Duplicating
          // either here as a generic "Buy Train" would be a second control
          // for one action, and the vaguer of the two.
          /* ==================================================================
             DESIGN NOTE 293: A CORPORATION MUST OWN A TRAIN
            ==================================================================

             REPORTED: a corporation with no trains can click End Turn in the
             Buy Trains step without buying one.

             1830 does not let it. A corporation that owns no train MUST buy
             one, and if its treasury cannot cover the cheapest in the depot
             the president pays the difference personally -- the emergency
             purchase. There is no branch of that rule where the turn simply
             ends.

             THE POVERTY CASE IS THE ONE THAT MATTERS, and it is why this is
             not merely disabled when the corporation could afford a train.
             Being unable to pay is precisely when a player wants the exit,
             and precisely when 1830 refuses it: the obligation falls to the
             president rather than lapsing. So the button stays disabled on
             an empty treasury too, and the tooltip names the president's
             purchase rather than implying the step is stuck.

             The gate is "owns a train", not "has bought one this turn" --
             a corporation that acquired one by trade has satisfied the rule
             just as completely. */
          {
            key: "end-turn",
            label: "End Turn",
            onClick: onEndOperatingTurn,
            disabled: mustBuyTrain,
            title: !mustBuyTrain
              ? "Finish this corporation's turn and pass to the next in the queue."
              : "A corporation must own a train. Buy one from the Bank Depot or another corporation -- if the treasury cannot cover it, the president buys it out of pocket.",
          },
        ];
        break;
    }
  } else {
    // Stock & Auction: Buy/Sell live entirely in `StockRoundPanel`'s own
    // corporation cards, so there is never a duplicate control surface.
    //
    // Design note #29: `onBuyShare`/`onSellShares` are no longer props of
    // this component at all. They were kept in the interface after the
    // controls moved out, unused, "to keep this a minimal-footprint
    // change" -- and then their signature changed to take a company id,
    // and four call sites failed to typecheck for a prop nobody reads.
    // Dead props are not free; they are a type error waiting for the real
    // implementation to move.
    contextualButtons = [];
  }


  /* ==================================================================
   *  DESIGN NOTE 33: THE ROUTE TOGGLE IS A RUN-TRAINS TOOL, NOT A
   *  GLOBAL ONE
   * ==================================================================
   *
   * `Routes` is this UI's name for the contract's run-trains sub-phase
   * (`OPERATING_SUB_PHASE_LABELS.Routes` renders as "Run Trains", mirroring
   * `or_phase::OR_PHASE_ORDER`). Sketching a route is only meaningful while
   * a corporation is about to run one, so that is the only time the toggle
   * exists now.
   *
   * Design note #11 argued the toggle was "harmless to leave on" outside
   * that phase. It was not, for two reasons that only show up in use:
   *
   *   1. IT SILENTLY DISARMS THE MAP. Leaving route mode on rewires the
   *      Rail Map's click handling -- look at the `queryClient`/
   *      `contractAddress`/`gameId`/`onHexClick` props below, every one of
   *      which is switched to `undefined` while `routeSelectMode` is true.
   *      A player who flipped the switch during Routes, moved to Track next
   *      turn and clicked a hex to lay tile would get a route point and no
   *      tile picker, with nothing on screen explaining why.
   *   2. IT ADVERTISED A CONTROL FOR A PHASE THE PLAYER WAS NOT IN, on the
   *      Auction and Stock Round tabs where there is no train to run at all.
   *
   * Hiding the button alone would have left hazard (1) intact -- the mode
   * would just become unreachable while still ON. So the owning component
   * force-clears `routeSelectMode` whenever this condition goes false; see
   * the `useEffect` next to the `routeSelectMode` state declaration. */
  const showRouteToggle = roundType === "OperatingRound" && orSubPhase === "Routes";

  /* Design note #278: the Dividends step's Pay-or-Withhold binary. Derived
     here rather than passed in, because both halves -- the step and the
     revenue -- are already props, and a second boolean saying what they
     jointly mean is a thing that can disagree with them. */
  const dividendChoiceForced =
    roundType === "OperatingRound" &&
    orSubPhase === "Dividends" &&
    dividendRevenue > 0 &&
    dividendRevenueIsThisTurn;

  /* ==================================================================
   *  DESIGN NOTE 31: ONE BAR, EVERYWHERE
   * ==================================================================
   *
   * This is now the app's ONLY action bar, and it renders on every active
   * tab. Two separate bars existed: this one (chunky, inside the workspace,
   * carrying the operating-round buttons plus Undo) and a slim
   * `GlobalActionBar` added at the top of the phase tab for Pass/Undo. On
   * the phase tab during a Stock Round BOTH rendered, one above the other,
   * with two Undo buttons -- because the phase tab falls through to this
   * component's branch as well.
   *
   * `GlobalActionBar` is deleted. This component absorbed Pass, kept Undo,
   * and was restyled slim, so there is exactly one strip of turn controls
   * no matter which tab is showing.
   *
   * PASS IS PHASE-ROUTED, and this is the part worth not getting wrong:
   * `WaterfallPass` and `PassTurn` are different contract messages, not one
   * action with two names. The caller decides which; this component just
   * renders the button and shows `passDisabledReason` when passing is
   * illegal (the waterfall forbids it while no bid stands anywhere).
   *
   * THE THREE TRAYS BELOW ARE NOT PART OF THE BAR. The hardware
   * marketplace, the Buy Private Company tray and the route-point readout
   * used to sit inside the bar's own container, which is most of what made
   * it "chunky" -- they are panels, not buttons, and one of them contains a
   * price slider. They now render UNDER the slim strip as their own blocks,
   * so the bar stays one row tall while the trays keep working. */
  return (
    <>
    <div
      style={{
        ...styles.actionBar,
        ...(isMyTurn ? styles.actionBarTurnPulse : {}),
        ...(condensed ? styles.actionBarCondensed : {}),
      }}
    >
      {/* The "Phase N of 6: Track" suffix is GONE, and its removal is the
          point rather than a simplification.

          The stepper below numbers from the steps this era actually has
          (design note #2 there): five in the Yellow era, six from Phase 3.
          This label numbered from the fixed six-entry table. So the moment
          the stepper shipped, the bar read "Phase 2 of 6: Track" directly
          above a strip whose first chip said "1 Lay Track" -- two different
          numbers for the same step, six inches apart.

          Reconciling them would mean two places computing one position.
          The strip already shows the position, the progress AND the
          sequence, so the text is redundant as well as contradictory; the
          honest fix is for one of them to stop making the claim. */}
      <span style={styles.actionBarRoundLabel}>
        {roundType === "OperatingRound"
          ? "Operating Round"
          : roundType === "StockRound"
            ? "Stock Round"
            : "No live round"}
      </span>
      {/* Operating Round turn stepper. Renders directly under the round
          label it elaborates: the label says WHICH step, the strip says
          where that step sits in the turn. Operating Round only -- there is
          no sub-phase sequence in a Stock Round or the auction, and a strip
          showing one would be inventing structure.

          Design note #212: the strip is a READ-ONLY indicator in every
          mode now, sandbox included. The only control on it is Skip, which
          dispatches the real `AdvanceOperatingSubPhase` -- see that
          component's design note #1 for why a clickable sandbox strip made
          the one place that tests the turn order unable to test it. */}
      {/* Design note #159: the targeting badge. A crosshair on the canvas
          only reads while the pointer is OVER the canvas -- a player who
          armed the mode and then looked at a panel has no way to tell it is
          still on. This says so where the controls are. */}
      {tokenTargetMode && (
        <div style={styles.tokenTargetBanner} role="status">
          <span style={styles.tokenTargetDot} aria-hidden="true" />
          Placing station token -- click a city hex on the Rail Map.
          <button
            type="button"
            style={styles.tokenTargetCancel}
            onClick={() => setTokenTargetMode(false)}
          >
            Cancel
          </button>
        </div>
      )}
      {/* ===================================================================
           DESIGN NOTE 164: THE OPERATING ROUND PANEL IS TWO ROWS
          ===================================================================

          It used to be one long wrapping strip: Pass Turn, a divider, every
          action for the current sub-phase, another divider, Undo, the route
          mode toggle, a spacer, the phase badge, the shift warning. On a
          narrow window that wrapped, and because the number of contextual
          buttons CHANGES with the sub-phase, the badges moved every time the
          turn advanced. A warning that relocates as the game progresses is a
          warning players stop tracking.

          Now: a stepper row, then an action row laid out as a THREE-COLUMN
          GRID -- `1fr auto 1fr`. The centre column holds the sub-phase
          actions and is genuinely centred on the panel, not merely centred
          in whatever space the sides left over, because the two `1fr` rails
          are equal by construction however wide their contents get. The
          badges dock left and the always-available utilities dock right, and
          neither can push the actions off-centre.

          THE FOUR "SKIP" BUTTONS ARE GONE. `Skip Track Lay`, `Skip Private
          Purchase`, `Skip Tokens` and `Skip Routes` all called
          `onSkipSubPhase` -- the exact handler the stepper's own "Advance
          Sub-Phase" button calls. Four names for one action, one of them
          present in every phase, which is what made the action row read as
          a pile of controls rather than as "what can I do here". Advancing
          is a property of the TURN, so it lives with the stepper that shows
          the turn; the action row now holds only things that actually
          change game state. */}
      {roundType === "OperatingRound" ? (
        <div style={styles.orPanel}>
          {/* ===================================================================
               DESIGN NOTE 228: WHOSE TURN IS IT, AND WHAT DO THEY HAVE
              ===================================================================

              A player presiding over three corporations had no single place
              telling them which one is acting. The information existed --
              the Round Detail table below the board highlights the active
              row, and the corporation roster carries treasuries -- but both
              are elsewhere on the page, and the action bar, which is where
              every decision is actually made, named no company at all. So
              the commonest question in an Operating Round ("am I spending
              PRR's money or NYC's?") required looking away from the controls
              that spend it.

              FOUR FACTS, chosen because each one gates a decision on this
              very bar rather than because they were available:

                TREASURY   caps every action in the turn -- a tile's terrain
                           cost, a token, a train.
                STATIONS   how many tokens are left and what the next one
                           costs, which is the Tokens step's whole decision
                           and was previously only on the button.
                TRAINS     what can run in the Routes step, and what the
                           train limit permits buying in Hardware.

              Rendered as a strip above the stepper: it describes the whole
              turn, and the stepper describes where in that turn you are. */}
          {/* ==================================================================
               DESIGN NOTE 236: THE BAR WEARS THE CORPORATION'S COLOUR
              ==================================================================

              Two changes, and the second is why the first matters.

              THE COLOUR IS THE IDENTITY NOW. This was a fixed dark navy with
              a small brand-coloured dot -- the same slab for every
              corporation, so telling PRR's turn from NYC's meant reading the
              ticker. The bar now takes `stationTickerColor`, the exact
              palette the station tokens on the map are drawn from, so the
              strip and the tokens the player is placing are visibly the same
              company. A player running three corporations can tell whose
              turn it is peripherally, which is the whole complaint.

              THE DOT WENT WITH IT. A brand-coloured dot on a brand-coloured
              bar is invisible, and it was only ever a miniature of the
              signal the bar now carries at full size.

              INK IS DERIVED, NOT ASSERTED. `bestContrastTextColor` is the
              same per-fill choice the map tokens use for their acronyms, so
              B&M's dark slate gets white text and C&O's orange gets black
              without either being hardcoded. Secondary text takes the same
              ink at reduced alpha rather than a fixed grey, which would go
              illegible on half the palette. */}
          <div
            style={{
              ...styles.orContextCard,
              backgroundColor: corporationBarInk.background,
              borderColor: corporationBarInk.border,
            }}
          >
            <span style={styles.orContextIdentity}>
              <span style={{ ...styles.orContextTicker, color: corporationBarInk.ink }}>
                {activeCorporation?.ticker ?? "No corporation"}
              </span>
              {activeCorporation?.fullName && (
                <span style={{ ...styles.orContextName, color: corporationBarInk.inkMuted }}>
                  {activeCorporation.fullName}
                </span>
              )}
              {activeCorporation?.presidentLabel && (
                <span
                  style={{
                    ...styles.orContextPresident,
                    color: corporationBarInk.inkMuted,
                    // Design note #298: identity detail, dropped when pinned.
                    ...(condensed ? { display: "none" } : {}),
                  }}
                >
                  {"\u{1F451} "}
                  {activeCorporation.presidentLabel}
                </span>
              )}
            </span>

            {activeCorporation && (
              <span style={styles.orContextFacts}>
                <span style={styles.orContextFact} title="Everything this corporation can spend this turn.">
                  <span style={{ ...styles.orContextFactLabel, color: corporationBarInk.inkMuted }}>
                    Treasury
                  </span>
                  <span style={{ ...styles.orContextFactValue, color: corporationBarInk.ink }}>
                    ${activeCorporation.treasury}
                  </span>
                </span>

                {/* ==================================================================
                     DESIGN NOTE 237: TOKENS, NOT A FRACTION
                    ==================================================================

                    This read `2/4 - $40 ea`, which was wrong about the money
                    and shaped wrong for the decision. The price is not flat:
                    the home token is free, the second is $40 and every one
                    after that is $100 (`utils/stationTokens.ts` design note
                    #0), so "$40 ea" understated a third token by 60%.

                    The row draws the corporation's whole allowance as
                    circles in placement order, each captioned with its own
                    cost, spent ones greyed in place. See
                    `StationTokenRow.tsx` for why it needs its own inset
                    surface on a brand-coloured bar. */}
                <span style={{ ...styles.orContextFact, ...(condensed ? { display: "none" } : {}) }}>
                  <span style={{ ...styles.orContextFactLabel, color: corporationBarInk.inkMuted }}>
                    Stations
                  </span>
                  <StationTokenRow
                    slots={activeCorporation.stationSlots}
                    color={corporationBarInk.background}
                    ink={corporationBarInk.ink}
                    inkMuted={corporationBarInk.inkMuted}
                    emptyLabel="no allowance reported"
                  />
                </span>

                <span style={styles.orContextFact}>
                  <span style={{ ...styles.orContextFactLabel, color: corporationBarInk.inkMuted }}>
                    Trains
                  </span>
                  {/* The same chips the Round Detail table draws, so a train
                      reads identically wherever it appears -- including the
                      amber tint on a tier that is about to rust. */}
                  {condensed ? null : activeCorporation.trains.length === 0 ? (
                    <span style={{ ...styles.orContextFactNone, color: corporationBarInk.inkMuted }}>
                      none
                    </span>
                  ) : (
                    <TrainChips
                      trains={activeCorporation.trains}
                      phase={phase ?? null}
                      surface="dark"
                      // Design note #259: the rust countdown, matching the
                      // Round Detail table below the board. Without
                      // `outlook` a chip's tooltip names WHAT will destroy
                      // it but not HOW SOON -- and "rusts when the first
                      // 4-train is bought" is a different decision from
                      // "rusts in one more purchase". The figure was
                      // already computed for the table; this bar simply
                      // was not being handed it.
                      outlook={rustOutlookForBar}
                    />
                  )}
                  {/* Design note #248: the limit, beside the fleet it caps.
                      The chips say WHICH trains; this says how much room is
                      left, which is the figure that decides whether the Buy
                      Trains step has anything in it. Amber at the ceiling,
                      because that is the state that ends the step. */}
                  {phase?.trainLimit !== undefined && (
                    <span
                      style={{
                        ...styles.orContextFactValue,
                        color:
                          activeCorporation.trains.length >= phase.trainLimit
                            ? "#e0c97a"
                            : corporationBarInk.ink,
                      }}
                      title={
                        activeCorporation.trains.length >= phase.trainLimit
                          ? `At the limit -- ${phase.tier}-phase corporations may hold ${phase.trainLimit}. The Buy Trains step is skipped automatically.`
                          : `${phase.tier}-phase corporations may hold ${phase.trainLimit} trains.`
                      }
                    >
                      {/* A bare "2 / 4" beside a row of train chips reads as
                          a second count OF those chips. Naming it is the
                          whole fix: the number was never ambiguous to
                          anyone who already knew what it was. */}
                      Train limit: {activeCorporation.trains.length} / {phase.trainLimit}
                    </span>
                  )}
                </span>
              </span>
            )}
          </div>

          {!condensed && (
          <div style={styles.orPanelStepperRow}>
            {/* Design note #235: UNDO lives on the sub-phase line now. It is
                the only control that moves the turn cursor BACKWARDS, so it
                belongs beside the strip that displays that cursor -- the two
                things that move the same pointer, together. */}
            <OperatingSubPhaseStepper
              current={orSubPhase}
              era={currentGlobalEra}
              trailing={
                <button
                  type="button"
                  style={{ ...styles.actionBarButton, ...styles.actionBarUtilityButton }}
                  onClick={onUndoLastAction}
                  disabled={!sessionReady}
                  title="Step the turn back. Always available, independent of round type."
                >
                  Undo
                </button>
              }
            />
          </div>
          )}

          <div style={styles.orPanelActionRow}>
            {/* LEFT RAIL -- docked status. Fixed home, so the phase badge and
                the rust warning sit in the same place all game. */}
            <div style={styles.orPanelRailLeft}>
              {phase && (
                <span style={{ ...styles.phaseBadge, ...PHASE_TINT_STYLES[phase.tint] }}>
                  {phase.label}
                </span>
              )}
              {phaseAlert && (
                <span
                  className={phaseAlert === "critical" ? "app-phase-shift-critical" : undefined}
                  style={{
                    ...styles.phaseShiftBadge,
                    ...(phaseAlert === "critical"
                      ? styles.phaseShiftBadgeCritical
                      : styles.phaseShiftBadgeWarn),
                  }}
                  title={
                    phase?.shiftWarning ??
                    (phase?.depotRemaining === 0
                      ? `No ${phase.tier}-Trains left in the Bank Depot.`
                      : `Only one ${phase?.tier}-Train left in the Bank Depot.`)
                  }
                >
                  {phaseAlert === "critical" ? (
                    <>&#9888; Phase Shift Imminent</>
                  ) : (
                    <>&#9888; Phase Shift in 2 Buys</>
                  )}
                </span>
              )}
            </div>

            {/* CENTRE -- only what this sub-phase can actually do. */}
            <div style={styles.orPanelActions}>
              {/* ===================================================================
                   DESIGN NOTE 279: NO PLACEHOLDER WHERE A CONTROL SHOULD BE
                  ===================================================================

                  This row used to fall back to "No button for this step --
                  use Skip to move on." whenever a sub-phase contributed no
                  contextual buttons.

                  Design note #180 wrote it to replace an even worse string
                  ("Nothing to do in this step"), and it kept that string's
                  central mistake: it describes the PANEL rather than the
                  player's options. Every step of an Operating Round has
                  something to do -- lay track, place a token, draw a route,
                  buy a train -- and a line saying otherwise was only ever
                  true of this one div.

                  It also aged badly. By the time the Run Routes controls had
                  moved into their own panel, `Routes` was the only step
                  reaching this branch -- so the one place the string
                  actually rendered was a step with a whole route planner
                  directly beneath it, telling the player there was nothing
                  here but Skip.

                  Deleted outright, and the Routes controls moved onto this
                  line (below) so the branch has content rather than a
                  caption about its absence. The Track hint survives because
                  it is the opposite kind of string: it says where the
                  action IS (on the map), which is a thing the player cannot
                  otherwise know. */}
              {contextualButtons.length === 0 && orSubPhase === "Track" && (
                <span style={styles.orPanelNoActions}>
                  Select a hex on the map to lay or upgrade track. Click the preview to rotate.
                </span>
              )}
              {contextualButtons.map((btn) => (
                <button
                  key={btn.key}
                  type="button"
                  style={styles.actionBarButton}
                  onClick={btn.onClick}
                  disabled={btn.disabled || !sessionReady}
                  title={btn.title}
                >
                  {btn.label}
                </button>
              ))}

              {/* ===================================================================
                   DESIGN NOTE 279: THE ROUTE MODE TOGGLE IS A TOOLBAR CONTROL
                  ===================================================================

                  Run Routes was the only sub-phase whose primary controls
                  lived somewhere other than this line. The toggle sat at the
                  top of `RoutePlannerPanel`, inside its border, above a
                  table of drafted routes -- which reads as a property of
                  those routes rather than as the tool that makes them.

                  It sits here now, immediately before Skip, because those
                  two ARE the choice on arriving at this step: pick how to
                  build a route, or decline to build one. The panel below
                  keeps everything that describes a route.

                  See `RoutePlannerPanel`'s design note #7 for why the
                  component itself still lives there rather than being
                  rebuilt here. */}
              {showRouteToggle && (
                <RouteModeToggle
                  mode={routeBuildMode}
                  onSelectMode={onSelectRouteBuildMode}
                  ownsAnyTrain={ownsAnyTrain}
                  controlsEnabled={sessionReady}
                  noTrainReason={NO_TRAIN_ROUTE_REASON}
                />
              )}

              {/* ==================================================================
                   DESIGN NOTE 258: SKIP IS AN ACTION, SO IT SITS WITH THE ACTIONS
                  ==================================================================

                  Design note #235 moved Skip onto the action ROW for the
                  right reason -- it is the alternative to whatever this step
                  offers -- but dropped it into the right RAIL, which is the
                  docked-utilities column. The row is a three-column grid
                  (`1fr auto 1fr`), so anything in that rail is pinned to the
                  far edge: Skip ended up flush right, half a panel away from
                  the buttons it is an alternative to.

                  It sits in the CENTRE column now, last in the group.
                  Declining is the fallback, so it reads after the things it
                  is a fallback to rather than competing for the first
                  glance.

                  ==================================================================
                   DESIGN NOTE 263: EXCEPT ON THE LAST STEP, WHERE IT IS A TWIN
                  ==================================================================

                  Buy Trains is the final sub-phase of a corporation's turn,
                  and it already carries "End Turn". Skip and End Turn there
                  are the same gesture wearing two labels: nothing follows
                  Buy Trains, so "move past this step without acting" IS
                  "finish this turn". Two buttons for one outcome is worse
                  than a redundant control -- it implies a distinction, and a
                  player who reads one has to work out what the other would
                  do differently.

                  So Skip is hidden on `Hardware` and End Turn is the sole
                  advancement, which is also the honest label: the turn is
                  what ends. Every earlier step keeps Skip, because on those
                  it genuinely does something End Turn does not -- move one
                  step and leave the rest of the turn intact. */}
              {/* ===================================================================
                   DESIGN NOTE 278: A CORPORATION THAT EARNED CANNOT DECLINE
                  ===================================================================

                  Skip was available on the Dividends step regardless of what
                  the trains had just earned, which offers a third option
                  1830 does not have. Once a corporation runs a route for
                  more than $0 the money EXISTS, and the rules give exactly
                  two places it can go: out to the shareholders, or into the
                  treasury. There is no third door where it evaporates.

                  Worse than merely wrong, it was the ONE step where skipping
                  silently destroyed value. Skipping Track or Tokens forgoes
                  an opportunity; skipping a declared $180 would have thrown
                  away $180 the corporation had already earned, and nothing
                  on screen said so.

                  So Skip disappears when there is revenue to allocate, and
                  the Pay/Withhold pair -- already the only two contextual
                  buttons on this step -- becomes the whole choice.

                  IT STAYS AT $0, which is the case the rule does not cover.
                  A corporation that ran nothing, or ran a route worth
                  nothing, has no money to allocate and no reason to be held
                  on this step; `DeclareDividends` for zero is a message with
                  no effect, so Skip is the honest control there. That is
                  also why this tests the REVENUE rather than the sub-phase:
                  the question is whether anything was earned, not which
                  step the cursor is on. */}
              {orSubPhase !== "Hardware" && !dividendChoiceForced && (
                <button
                  type="button"
                  style={{ ...styles.actionBarButton, ...styles.actionBarUtilityButton }}
                  onClick={onSkipSubPhase}
                  disabled={!sessionReady}
                  title={`Move past ${OPERATING_SUB_PHASE_LABELS[orSubPhase].stepLabel} without acting. Dispatches AdvanceOperatingSubPhase -- the contract moves its own cursor one step.`}
                >
                  Skip {OPERATING_SUB_PHASE_LABELS[orSubPhase].stepLabel} &#8250;
                </button>
              )}
            </div>

            {/* RIGHT RAIL -- always-available utilities, never sub-phase
                specific, so they do not belong in the centre. */}
            <div style={styles.orPanelRailRight}>
              {/* Design note #266: the Auto Route / Manual Route pair used to
                  live here, in the docked-utilities rail. They are not
                  utilities -- they are the first step of the Run Routes
                  task -- and they now head `RoutePlannerPanel` below as one
                  segmented control. See that file's design note #0 for why
                  the three regions became one column. */}
            </div>
          </div>
        </div>
      ) : (
      <div style={styles.actionBarButtons}>
        {/* Design note #31: Pass leads -- it is the action available in
            every phase, and the one a player reaches for most. */}
        <button
          type="button"
          style={{
            ...styles.actionBarButton,
            ...(!sessionReady || passDisabledReason !== null
              ? styles.actionBarButtonDisabled
              : {}),
          }}
          onClick={onPassTurn}
          disabled={!sessionReady || passDisabledReason !== null}
          title={passDisabledReason ?? "Pass / skip your turn."}
        >
          Pass Turn
        </button>
        <span style={styles.actionBarDivider} />
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
        {/* The route mode toggle used to render here too. It is
            `showRouteToggle`-gated, and that flag is OR-and-Routes-only, so
            in this NON-Operating-Round branch it was unreachable markup.
            Removed rather than left as a second copy to keep in step with
            the live one in the OR panel above. */}

        {/* Design note #40: the phase badge, pinned right. `marginLeft:
            auto` on the spacer rather than on the badge itself, because the
            badge is conditional -- an auto margin on a node that sometimes
            does not render would silently stop pinning anything. */}
        <span style={styles.actionBarSpacer} />
        {phase && (
          <span style={{ ...styles.phaseBadge, ...PHASE_TINT_STYLES[phase.tint] }}>
            {phase.label}
          </span>
        )}
        {/* Design note #7 (`gamePhase.ts`): TWO steps, not one. This badge
            used to render identically at two purchases and at one, so the
            last purchase before a rust -- the single most consequential
            moment in an 1830 game -- looked exactly like the moment before
            it. It now reads the same `phaseAlertLevel` helper the train
            chips do, so the bar and the chips escalate together.

            The wording escalates with the colour: "Imminent" is a claim
            about the next purchase, and it was previously being made one
            purchase too early. */}
        {phaseAlert && (
          <span
            className={phaseAlert === "critical" ? "app-phase-shift-critical" : undefined}
            style={{
              ...styles.phaseShiftBadge,
              ...(phaseAlert === "critical"
                ? styles.phaseShiftBadgeCritical
                : styles.phaseShiftBadgeWarn),
            }}
            // The exact consequence, per tier. Falls back to a plain
            // depot-count statement for the 2-train case, which empties
            // without triggering anything -- see `PHASE_SHIFT_CONSEQUENCE`.
            title={
              phase?.shiftWarning ??
              (phase?.depotRemaining === 0
                ? `No ${phase.tier}-Trains left in the Bank Depot.`
                : `Only one ${phase?.tier}-Train left in the Bank Depot.`)
            }
          >
            {phaseAlert === "critical" ? (
              <>&#9888; Phase Shift Imminent</>
            ) : (
              <>&#9888; Phase Shift in 2 Buys</>
            )}
          </span>
        )}
      </div>
      )}
    </div>

    {/* ---- Contextual trays -- design note #31 --------------------------
        Panels, not bar content: a train marketplace, a private-company
        purchase tray with a price slider, and the route-point readout.
        Each is narrowly conditional (a specific OR sub-phase, or the route
        toggle being on), so most of the time none of this renders at all
        and the bar above is the entire control surface. */}
      {/* Phase 4's marketplace selection tray -- see design note #10/item 2.
          `BuyHardwareFromPool` has no per-model parameter yet (see
          `MOCK_TRAIN_CATALOG`'s own doc comment), so selecting a card here
          only changes which model is highlighted/labeled; the purchase
          itself still targets whichever unit the pool auto-assigns. */}
      {/* Design note #188: the consequence of each option, laid out before
          the player commits. Two things they could not otherwise see: WHO
          gets paid and how much, and WHERE the stock token lands. Both are
          computable from state already on screen, and both were being left
          for the player to work out. */}
      {roundType === "OperatingRound" && orSubPhase === "Dividends" && (
        <div style={styles.dividendPanel}>
          <div style={styles.dividendColumn}>
            <span style={styles.dividendHeading}>
              Pay out ${dividendRevenue} &middot; ${dividendPerShare}/share
            </span>
            {dividendPayouts.length === 0 ? (
              <span style={styles.dividendNote}>
                No shareholders on record -- the whole payout would go to the bank pool.
              </span>
            ) : (
              dividendPayouts.map((row) => (
                <span key={row.holder} style={styles.dividendRow}>
                  <span>{row.holder}</span>
                  <span style={styles.dividendAmount}>
                    ${row.amount} <span style={styles.dividendPct}>({row.percentage}%)</span>
                  </span>
                </span>
              ))
            )}
            <MarketMoveLine
              currentPrice={dividendPrice}
              projection={payProjection}
              direction="pay"
            />
          </div>

          <div style={styles.dividendColumn}>
            <span style={styles.dividendHeading}>Withhold ${dividendRevenue}</span>
            <span style={styles.dividendNote}>
              The full amount stays in the corporation's treasury. Shareholders receive nothing
              this Operating Round.
            </span>
            <MarketMoveLine
              currentPrice={dividendPrice}
              projection={withholdProjection}
              direction="withhold"
            />
          </div>
        </div>
      )}
      {/* ===================================================================
           DESIGN NOTE 203: THE HARDWARE TRAY MOVED OUT OF THE BAR
          ===================================================================

          Design note #182 correctly reduced a six-card selector to the ONE
          train 1830's cheapest-first depot will actually sell. What it could
          not fix, sitting inside the action bar, is that the depot was only
          half the step: a corporation in the Hardware sub-phase can buy from
          the bank OR from another corporation, and the second half lived in
          a completely separate panel further down the page.

          Both halves are now `TrainPurchasePanel`, rendered by the shell --
          see that file's design note #0 for why they are two sections rather
          than one control, and #1 for the quantity field this tray had
          nowhere to put. The bar keeps only "End Turn" for this step, which
          is the one thing here that is a button rather than a panel. */}
      {/* ===================================================================
           DESIGN NOTE 165: THE INLINE BUY-PRIVATE TRAY IS GONE
          ===================================================================

          It was a select, a range slider and a Buy button wedged into the
          action bar, and it modelled the purchase as a UNILATERAL act: pick
          a private, drag a price, buy it. In 1830 that transaction needs the
          owner's agreement, and a slider you drag past somebody else's
          property does not represent one.

          `ProposePrivatePurchase` replaces it -- a real sheet with the
          eligible privates, each showing its owner and its legal band, and
          a typed price rather than a drag. Typing matters here: the band is
          50-200% of face value, so a $100 private has a 51-value range and
          a slider makes hitting an exact intended figure fiddly.

          The tray also sat under the HARDWARE sub-phase, which is wrong --
          `trading.rs`'s own sub-phase gate puts private purchase FIRST in
          the turn, before track. The button now lives in the `BuyPrivate`
          step where the contract expects it. */}
      {/* ===================================================================
           DESIGN NOTE 266: THE RUN ROUTES STEP IS ONE PANEL NOW
          ===================================================================

          Everything this step needs moved into `RoutePlannerPanel` -- the
          mode toggle that was in the right rail, the run button that was in
          the centre column, and the waypoint readout that was here. See
          that file's design note #0 for the reading-order argument.

          It renders on the whole `Routes` sub-phase rather than only while
          route mode is engaged. The old panel was gated on
          `routeSelectMode`, which made the toggle that turns route mode on
          live somewhere else by necessity -- a control cannot switch on the
          panel it is inside. Rendering on the sub-phase breaks that loop. */}
      {/* Design note #0 in `PrivatePowerPanel.tsx`: the abilities, gated on
          ownership and on the round they may be used in. Renders nothing
          outside sandbox, and nothing when the viewer owns none. */}
      <PrivatePowerPanel
        privateCompanies={privateCompanies}
        viewerAddress={privatePowerViewer}
        roundType={roundType}
        sandbox={sandboxMode}
        usedAbilities={usedPrivateAbilities}
        onUseAbility={onUsePrivateAbility}
        controlsEnabled={sessionReady}
      />
      {showRouteToggle && (
        <RoutePlannerPanel
          drafts={trainDrafts}
          activeTrainIndex={trainDrafts.length === 0 ? null : activeTrainIndex}
          onSelectTrain={onSelectRouteTrain}
          onClearRoute={onClearRoute}
          onRunRoute={onRunTrains}
          ownsAnyTrain={ownsAnyTrain}
          controlsEnabled={sessionReady}
          noTrainReason={NO_TRAIN_ROUTE_REASON}
          clickFeedback={routeFeedback}
        />
      )}
      {!sessionReady && (
        <span style={styles.sidebarHint}>Initialize the session key above to enable these actions.</span>
      )}
    </>
  );
}

/** Design note #47: the credit's hover/focus states, which inline styles
 *  cannot reach. Kept next to the tab bar's own escape hatch so this file
 *  has one place where raw CSS lives rather than several. */
const NETA_CREDIT_CSS = `
.neta-credit { transition: color 120ms ease, text-shadow 120ms ease; }
.neta-credit:hover { color: #ffffff; text-shadow: 0 0 8px rgba(255,255,255,0.35); }
.neta-credit:focus-visible { outline: 2px solid #94a3b8; outline-offset: 2px; color: #ffffff; }
`;

/* ------------------------------------------------------------------ */
/* Main tabs -- see design note #9                                    */
/* ------------------------------------------------------------------ */

/* ==================================================================== */
/*  DESIGN NOTE 28: PHASE TAB vs REFERENCE BOARDS                       */
/* ==================================================================== */
//
// `"phase"` is new, and splitting it out fixes a conflation that had been
// there since the tabs were flattened. One tab used to be both "the thing
// you act in" and "the stock market chart", renaming itself between
// "Auction", "Stock Round" and "Stock Market" depending on the round. That
// meant the 2D market chart -- a REFERENCE board a player wants to consult
// at any time, including mid-auction to see where prices stand -- was
// unreachable during the two phases where it is most worth consulting,
// because the tab that would have shown it was busy being the auction.
//
// The split is along a real line:
//
//   ACTIONABLE   `"phase"`  the surface where the current round is played.
//                           Auction dashboard, or Stock Round panel.
//   REFERENCE    `"map"`    the rail map (also actionable in an OR).
//                `"stock"`  the market chart. Always just a board.
//                `"ledger"` / `"rules"`  never actionable.
//
// The Operating Round is the one phase with no dedicated `"phase"` surface,
// because its actionable surface IS the rail map -- so during an OR the
// phase tab is simply absent and `"map"` leads instead. That is why
// `orderedMainTabs` returns a LIST rather than a fixed array with a
// reshuffle: the tab set itself changes shape by phase, not just its order.
//
/* ==================================================================== */
/*  DESIGN NOTE 41: `"corps"` -- THE PERSISTENT STOCKS TAB              */
/* ==================================================================== */
//
// The corporation roster used to be reachable ONLY as the Stock Round's
// phase surface. That made "who owns what, and what is it worth" a fact you
// could look up during a Stock Round and nowhere else -- including during
// the Operating Round that decides those valuations, which is precisely
// when a player wants to check them.
//
// `"corps"` is therefore its own tab, present in every phase, and during a
// Stock Round it simply IS the phase surface (there is no separate
// `"phase"` tab that round, the same way an Operating Round has none).
//
// NAMING, because this is a trap worth marking: the id is `"corps"` and the
// LABEL is "Stocks", while a DIFFERENT tab has the id `"stock"` and the
// label "Stock Market". `"stock"`/`"stocks"` as sibling ids would be one
// letter apart and impossible to review; the two surfaces are unrelated
// (one is a corporation roster, one is the price chart).
type MainTab = "phase" | "corps" | "map" | "stock" | "ledger" | "rules";

/** The tabs to show, in order, for the current round.
 *
 *  The active phase always leads. A player's attention starts at the left
 *  edge, and in a game where the legal action changes completely between
 *  rounds, the first tab should be the one they can actually act in --
 *  otherwise every phase transition begins with a hunt. */
function orderedMainTabs(roundType: RoundType | null): { id: MainTab; label: string }[] {
  const reference: { id: MainTab; label: string }[] = [
    { id: "stock", label: "Stock Market" },
    { id: "ledger", label: "Game Ledger" },
    { id: "rules", label: "Rules Reference" },
  ];
  const railMap = { id: "map" as MainTab, label: "Rail Map" };
  // Design note #41: present in every branch below, without exception.
  const stocks = { id: "corps" as MainTab, label: "Stocks" };

  switch (roundType) {
    case "WaterfallAuction":
      return [{ id: "phase", label: "Auction" }, stocks, railMap, ...reference];
    case "StockRound":
      // No separate phase tab: Stocks IS the Stock Round's surface, and a
      // duplicate tab rendering the identical panel would be a bug that
      // merely looked like a feature.
      return [stocks, railMap, ...reference];
    case "OperatingRound":
      // No phase tab: the rail map is the operating round's own surface.
      return [railMap, stocks, ...reference];
    default:
      // Round type not yet known (first paint, or offline). Rail map first
      // -- it is the one surface that renders without any chain data.
      return [railMap, stocks, ...reference];
  }
}

/** Whether `tab` exists for `roundType`. Used to redirect off a tab that
 *  has just disappeared under the player -- e.g. sitting on the Auction tab
 *  when the auction ends. */
function isTabAvailable(tab: MainTab, roundType: RoundType | null): boolean {
  return orderedMainTabs(roundType).some((entry) => entry.id === tab);
}

/* ==================================================================
 *  DESIGN NOTE 213: ONE ANSWER TO "WHICH TAB IS THIS ROUND PLAYED ON"
 * ==================================================================
 *
 * REPORTED BUG: leaving the auction for a Stock Round dumped the player on
 * the Rail Map instead of the Stock & Auction surface.
 *
 * The cause was two effects disagreeing, and the loser winning. The
 * transition effect correctly sent a new Stock Round to `"corps"`. The
 * availability guard right below it -- which exists because the tab SET
 * changes shape by phase, so the active tab can cease to exist under the
 * player -- then ran in the same commit, still reading `activeMainTab` as
 * `"phase"` (React has not re-rendered, so the value the first effect set is
 * not visible yet), found that `"phase"` is not in a Stock Round's tab list,
 * and redirected to a hardcoded `"map"`. Declared second, so it landed
 * second, so the Rail Map won every time.
 *
 * Reordering the effects would "fix" it by luck and break again the moment
 * anything else set a tab. The real defect is that the guard had its own
 * opinion about where to land, and that opinion was a constant. Both callers
 * now ask this one function, so whichever runs last, they agree.
 *
 * The mapping is design note #28's own split, stated once: the auction has a
 * dedicated phase surface; a Stock Round's surface IS the Stocks roster
 * (design note #41 -- there is no `"phase"` entry that round to land on);
 * an Operating Round is played on the rail map.
 */
function surfaceTabFor(roundType: RoundType | null): MainTab {
  switch (roundType) {
    case "WaterfallAuction":
      return "phase";
    case "StockRound":
      return "corps";
    case "OperatingRound":
      return "map";
    default:
      // Round type not yet known (first paint, or offline). The rail map is
      // the one surface that renders without any chain data.
      return "map";
  }
}

function MainTabBar({
  activeTab,
  onSelect,
  roundType,
  onOpenTutorials,
}: {
  activeTab: MainTab;
  onSelect: (tab: MainTab) => void;
  /** Opens the on-demand tutorial library -- design note #158. */
  onOpenTutorials: () => void;
  /** Design note #28: decides both which tabs exist and their order.
   *  `null` before the first `GetGameState` resolves. */
  roundType: RoundType | null;
}) {
  // Design note #28: the tab set is computed, not a fixed array. Superseded
  // design note #26's single self-renaming tab, which conflated the phase
  // surface with the market chart -- see #28 for why that had to split.
  const tabs = orderedMainTabs(roundType);
  return (
    <div style={styles.mainTabBar}>
      {/* Design note #46: hover states need real CSS.
          Inline `React.CSSProperties` cannot express `:hover` (Lobby.tsx
          design note #3), and an unselected tab that never responds to the
          pointer is the specific thing that made these read as disabled.
          Same `<style>`-tag escape hatch the turn pulse and the auction
          glow already use, scoped to one class so it cannot leak. */}
      <style>{MAIN_TAB_HOVER_CSS}</style>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={activeTab === tab.id ? "nav-tab nav-tab-active" : "nav-tab"}
          aria-current={activeTab === tab.id ? "page" : undefined}
          style={{
            ...styles.mainTabButton,
            ...(activeTab === tab.id ? styles.mainTabButtonActive : {}),
          }}
          onClick={() => onSelect(tab.id)}
        >
          {tab.label}
        </button>
      ))}

      {/* Design note #158: the Tutorials front door.
          Pinned right, past an auto margin, and deliberately NOT styled as a
          fifth tab -- it does not change which screen you are on, it opens a
          reader over whichever screen you are already on. Giving it the tab
          treatment would have implied a navigation it does not perform, and
          put a permanently-unselected tab next to four that highlight. */}
      <span style={{ marginLeft: "auto" }} />
      <button
        type="button"
        className="nav-tab"
        style={styles.tutorialsButton}
        onClick={onOpenTutorials}
        title="Read any tutorial at any time -- the auction, the Stock Round, the Operating Round, or the stock market."
      >
        &#63; Tutorials
      </button>
    </div>
  );
}

/** Design note #46: the hover/focus half of the tab treatment.
 *
 *  Only the states inline styles cannot reach live here -- the resting and
 *  active looks stay in `styles.mainTabButton`/`mainTabButtonActive`, so
 *  there is one place to read a tab's normal appearance rather than two
 *  that have to be kept in agreement.
 *
 *  `:focus-visible` mirrors hover because a keyboard user needs the same
 *  affordance a mouse user gets, and the browser default outline is nearly
 *  invisible against this dark chrome. */
const MAIN_TAB_HOVER_CSS = `
.nav-tab { transition: color 120ms ease, border-color 120ms ease, background-color 120ms ease; }
.nav-tab:hover { color: #e2e8f0; border-color: #64748b; background-color: #1e2330; }
.nav-tab:focus-visible { outline: 2px solid #94a3b8; outline-offset: -2px; color: #e2e8f0; }
.nav-tab-active:hover { color: #ffffff; border-color: rgba(255,255,255,0.8); }
`;

/* ------------------------------------------------------------------ */
/* Active Player Turn Notifications -- CSS pulse keyframes, see design    */
/* note #18/item 4. `document.title` flashing (the other half of this    */
/* notification) lives in utils/turnAlert.ts instead -- no DOM footprint */
/* to inject here. Same `<style>`-tag keyframes escape hatch Chatbox.tsx */
/* already established (that file's own design note #2) for this        */
/* codebase's plain-inline-style convention, which cannot express a      */
/* `@keyframes` rule at all.                                             */
/* ------------------------------------------------------------------ */

/* Design note #35: WHITE, not red.
 *
 * This pulse used to be red, and so did the mini-auction ring in
 * `WaterfallAuctionDashboard.tsx`. Two red pulses on screen simultaneously
 * read as one effect, which is worst exactly when both are firing: your
 * turn, during a contested mini-auction.
 *
 * The turn indicator is the one that moved, because it is the one drawn
 * over EVERYTHING. It sits on the dark chrome, the linen-white cards and
 * the map canvas in turn, and white/crisp silver is the only ink that keeps
 * a consistent weight across all three -- red read as urgent on the dark
 * shell and as a smudge over the cards. Red is now exclusively the
 * auction's "contested" colour. */
const TURN_PULSE_KEYFRAMES_CSS = `
@keyframes app-turn-pulse-glow {
  0%, 100% {
    box-shadow: inset 0 0 0 rgba(${TURN_PULSE_INK_RGB}, 0),
                0 0 0 rgba(${TURN_PULSE_INK_RGB}, 0);
  }
  50% {
    box-shadow: inset 0 0 40px rgba(${TURN_PULSE_INK_RGB}, 0.28),
                0 0 30px rgba(${TURN_PULSE_INK_RGB}, 0.4);
  }
}
`;

/* The phase-shift badge's CRITICAL step -- one purchase from the shift.
 *
 * Opacity rather than the box-shadow glow the other two pulses use. This
 * badge sits inline in a crowded action bar, where a spreading glow would
 * bleed over the controls either side of it; the turn overlay and the
 * auction card both own their whitespace and can afford one.
 *
 * The pulse bottoms out at 0.55, not 0. A warning that blinks fully out is
 * unreadable for half its cycle, and this one carries text the player needs
 * to actually read.
 *
 * Reduced motion drops the animation and keeps the static crimson, exactly
 * as `WaterfallAuctionDashboard.tsx` does: the player still sees WHICH step
 * of the countdown they are on, just without the movement. Escalation must
 * survive the animation being switched off, which is the other reason the
 * two steps differ in colour and not merely in whether they pulse. */
/** `GamePhase.tint` -> the tile tier that phase has unlocked.
 *
 *  `tint` is already the exact three-value era `gamePhase.ts`'s
 *  `TIER_PRESENTATION` assigns (Phase 2 yellow; Phases 3-4 green; Phases
 *  5/6/D brown), so this is a case change rather than a second opinion about
 *  which era it is. Written as a table anyway rather than a string cast, so
 *  a fourth `PhaseTint` would fail to compile here instead of silently
 *  producing a `TileColorTier` that does not exist. */
const ERA_FOR_PHASE_TINT: Readonly<Record<PhaseTint, TileColorTier>> = {
  yellow: "Yellow",
  green: "Green",
  brown: "Brown",
};

const PHASE_SHIFT_PULSE_CSS = `
@keyframes app-phase-shift-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}
@media (prefers-reduced-motion: reduce) {
  .app-phase-shift-critical { animation: none !important; }
}
`;

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

  /* Design note #1 in `PrivatePowerPanel.tsx`: which abilities have fired.
     Local, because there is no contract message to read it back from --
     the panel exists so the surface and its two gates are testable, and
     this is the smallest state that makes "Used" mean something. */
  const [usedPrivateAbilities, setUsedPrivateAbilities] = useState<ReadonlySet<number>>(
    () => new Set<number>(),
  );

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
   */
  const [, setSandboxHistory] = useState<
    Array<{ state: GameStateResponse; mapGrid: MapGridResponse; subPhase: OperatingSubPhase }>
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
  const [srParValue, setSrParValue] = useState<string>(MOCK_BUY_STOCK_PAR_VALUE);

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
  const mustBuyTrain = useMemo(() => {
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
      presidentLabel: company.president
        ? (sandboxPlayerLabel(company.president) ?? truncateAddress(company.president))
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
    sandboxInitialMarketPrices(marketCellForPrice),
  );
  // Re-seeded on a scenario change for the same reason the other two are:
  // picking a scenario means "show me that screen", not "carry my moved
  // tokens into it".
  useEffect(() => {
    setSandboxMarket(sandboxInitialMarketPrices(marketCellForPrice));
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
  useEffect(() => {
    setOrSubPhase(
      sandbox ? "Track" : initialOrSubPhase(gameState?.current_global_era),
    );
  }, [gameState?.current_round_type, gameState?.active_corporation_index, gameState?.current_global_era, sandbox]);

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
    }
  }, [gameState?.current_round_type]);

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
  const tileSelectorArmed =
    !spectator &&
    (gameState?.current_round_type ?? null) === "OperatingRound" &&
    orSubPhase === "Track";

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
    if (!tileSelectorArmed) return undefined;
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
      // Design note #252/#253: the acting corporation's colour, lifted if it
      // is too dark to read as light against the veiled board.
      glowColor: glowColorFor(stationTickerColor(actingProtocolId)),
    };
  }, [tileSelectorArmed, gameState, actingProtocolId, mapGrid]);


  /* Design note #199, layer 3: a ring left open when the turn moves on. The
     sub-phase can advance without a board click -- the stepper's Advance
     button, a token placed, another player's action arriving on a poll -- so
     closing on the next click would leave the carousel floating over a board
     that has moved past it. */
  useEffect(() => {
    if (tileSelectorArmed) return;
    setRadialSelector(null);
    setPreviewTile(null);
  }, [tileSelectorArmed]);

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
    if (!tileSelectorArmed) {
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
  }, [tileSelectorArmed]);

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
      glowColor: glowColorFor(stationTickerColor(actingProtocolId)),
    };
  }, [tokenTargetMode, activeStationCompany, actingProtocolId, gameState, mapGrid]);


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
  const [routesRunThisTurn, setRoutesRunThisTurn] = useState<{
    protocolId: number;
    ran: boolean;
  } | null>(null);
  useEffect(() => {
    setRoutesRunThisTurn(null);
  }, [actingProtocolId]);
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
  /* Design note #286: opens on AUTO. `RouteBuildMode`'s own note argued for
     "manual" because it is what the map does anyway once the planner is
     engaged, so an unselected-looking control would have been describing
     the mode it was already in. True, and it optimised for the wrong
     player: drafting by hand is the expert path, and the tracer's answer is
     the better starting point for everyone else -- including an expert, who
     can edit it. Auto also SHOWS something on arrival rather than an empty
     table. */
  const [routeBuildMode, setRouteBuildMode] = useState<RouteBuildMode>("auto");

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
    // Back to the default for the next corporation's turn -- design note
    // #286: a draft to edit rather than a blank table.
    setRouteBuildMode("auto");
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
    // Clearing hands the route back to the player -- which is exactly what
    // the button's tooltip promises ("This allows you to manually enter a
    // route for this train"), so the toggle has to agree with it.
    setRouteBuildMode("manual");
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

  /* Design note #286: OPENING ON AUTO MEANS ACTUALLY DRAFTING.
     A toggle set to Auto-Route above an empty table is worse than opening
     on Manual -- it claims a draft exists. `handleSelectRouteBuildMode`
     only runs the tracer when the player CLICKS auto, so arriving in that
     mode has to run it too.

     Guarded per corporation rather than per render: the tracer is a search,
     and re-running it after every board change would overwrite a route the
     player has since edited by hand. One draft on arrival, then it is
     theirs. */
  const autoDraftedForRef = useRef<number | null>(null);
  useEffect(() => {
    if (!inRunTrainsSubPhase) {
      autoDraftedForRef.current = null;
      return;
    }
    if (routeBuildMode !== "auto") return;
    if (autoDraftedForRef.current === actingProtocolId) return;
    autoDraftedForRef.current = actingProtocolId;
    handleAutoRoute();
  }, [inRunTrainsSubPhase, routeBuildMode, actingProtocolId, handleAutoRoute]);

  /* Design note #266: the segmented toggle's handler. Auto is a mode the
     player selects AND the act of drafting -- selecting it re-runs the
     tracer, which is what makes re-selecting it after editing a way to
     start over from the machine's answer. */
  const handleSelectRouteBuildMode = useCallback(
    (mode: RouteBuildMode) => {
      setRouteBuildMode(mode);
      setRouteFeedback(null);
      setRouteSelectMode(true);
      if (mode === "auto") handleAutoRoute();
    },
    [handleAutoRoute],
  );

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

      /* Design note #266: EDITING A DRAFT MAKES IT YOURS. The moment a
         click lands, the path is no longer the one `autoTraceRoute`
         returned, and a toggle still reading "Auto-Route" would be
         describing a route that no longer exists. The drafted hexes stay --
         drafting into an editable builder is the entire point -- but the
         label stops crediting the tracer for them. */
      setRouteBuildMode("manual");

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
          `${info.hexLabel} cannot START a route. Routes begin at a city or a red off-board hex -- towns and plain track are passed through.`,
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
            `${point.hexLabel} is already on this route. A route may not visit the same hex twice -- click ${last.hexLabel} to step back instead.`,
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
      };
    });
  }, [ownedTrainRoster, routeDrafts, mapGrid, currentPhase, ownsAnyTrain]);

  /* Design note #275: one overlay per drafted train, so the board shows the
     whole turn at once rather than whichever route was drawn last.

     THE COLOUR IS SHARED. All of them are this corporation's routes, so all
     of them wear its colour (design note #254) -- distinguishing them by
     hue would invent a second meaning for a channel that already answers
     "whose turn is this". The ACTIVE train's route is the one the player is
     editing, and that is what the panel's row highlight says. */
  const manualRouteOverlay = useMemo<RouteOverlay[]>(() => {
    const color = glowColorFor(stationTickerColor(actingProtocolId));
    const overlays: RouteOverlay[] = [];
    for (const train of ownedTrainRoster) {
      const points = routeDrafts[train.trainIndex] ?? [];
      // `drawRouteOverlays` skips anything shorter, but filtering here keeps
      // the array identity stable for the canvas's dependency check.
      if (points.length < 2) continue;
      overlays.push({
        trainLabel: `${train.model}-Train`,
        color,
        hexes: points.map((point) => [point.q, point.r] as [number, number]),
      });
    }
    return overlays;
  }, [ownedTrainRoster, routeDrafts, actingProtocolId]);

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

  const handleUsePrivateAbility = useCallback(
    (ability: PrivateAbility) => {
      setUsedPrivateAbilities((prev) => {
        const next = new Set(prev);
        next.add(ability.privateId);
        return next;
      });
      logInfoRef.current?.(
        "Private Power",
        `${ability.action} -- ${ability.description}`,
      );
    },
    [],
  );

  const logInfo = useCallback((label: string, detail: string) => {
    const id = nextLogEntryId++;
    const timestamp = new Date().toLocaleTimeString();
    const timestampMs = Date.now();
    setActionLog((log) => [{ id, label, status: "info", detail, timestamp, timestampMs }, ...log]);
  }, []);

  /* `logInfo` is defined below the handler that uses it, so the handler
     reads it through a ref rather than forcing a reorder of a 6000-line
     file for one call. */
  const logInfoRef = useRef<((label: string, detail: string) => void) | null>(null);
  useEffect(() => {
    logInfoRef.current = logInfo;
  }, [logInfo]);

  const runGameplayAction = useCallback(
    async (fallbackLabel: string, msg: GameplayExecuteMsg) => {
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
        projectPrice: (price: number, choice: "pay" | "withhold") =>
          projectDividendMove(price, choice)?.price ?? null,
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
        if (!("UndoLastAction" in msg) && before) {
          setSandboxHistory((stack) =>
            [...stack, { state: before, mapGrid, subPhase: orSubPhase }].slice(
              -SANDBOX_HISTORY_LIMIT,
            ),
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

          if (result.charge && after) {
            const { player, amount } = result.charge;
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
          if (result.won) {
            logInfo(
              "Private Won",
              `${sandboxPlayerLabel(result.won.player) ?? truncateAddress(result.won.player)} won ${result.won.name} for $${result.won.price}.`,
            );
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
          const { companyId, from, to } = marketResult.moved;
          const ticker =
            before?.public_companies.find((entry) => entry.company_id === companyId)?.ticker ??
            `#${companyId}`;
          logInfo("Market Move", `${ticker} fell from $${from} to $${to} on the sale.`);
        }

        if (after) {
          after = applySandboxAction(after, msg, {
            // Only `RunManualRoute` reads this, to total the printed value of
            // the stops the player picked instead of paying a flat nominal
            // for every route regardless of length.
            mapGrid,
            era: ERA_FOR_PHASE_TINT[currentPhase?.tint ?? "yellow"],
            // Design note #273: what the chart says this share is worth, so
            // the wallet and the market agree about one trade.
            sharePrice: marketResult.tradePrice ?? undefined,
          });
          sandboxStateRef.current = after;
          setSandboxState(after);
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
            detail: "Spectator mode -- watching only. Join from the lobby to play.",
            timestamp,
            timestampMs,
          },
          ...log,
        ]);
        return;
      }

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
        const previous = stack[stack.length - 1];
        if (!previous) {
          logInfo("Undo", "Nothing to undo -- this is the start of the scenario.");
          return stack;
        }
        sandboxStateRef.current = previous.state;
        setSandboxState(previous.state);
        setMapGrid(previous.mapGrid);
        setOrSubPhase(previous.subPhase);
        // Any in-flight preview belonged to the state just discarded.
        setPreviewTile(null);
        setRadialSelector(null);
        logInfo("Undo", "Reverted the last sandbox action.");
        return stack.slice(0, -1);
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
            par_value: isFloated ? null : srParValue,
          },
        },
      );
    },
    [runGameplayAction, gameId, gameState, srParValue],
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
        !draft.endsOffTerminus,
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
      const offTerminus = drafted.find((draft) => draft.endsOffTerminus);
      if (offTerminus) {
        const last = offTerminus.hexLabels[offTerminus.hexLabels.length - 1];
        setRouteFeedback(
          `${last} cannot END a route. Routes finish at a city or a red off-board hex -- click one to finish, or click ${last} again to step back.`,
        );
        return;
      }
      setRouteFeedback("No drafted route can run yet.");
      return;
    }

    for (const draft of runnable) {
      const points = routeDraftsRef.current[draft.trainIndex] ?? [];
      if (points.length < 2) continue;
      // eslint-disable-next-line no-await-in-loop
      await runGameplayAction("RunManualRoute", {
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
      });
    }

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
  const handleDeclareDividendsChoice = useCallback(
    (distribute: boolean) => {
      const corporation = gameState?.public_companies.find(
        (entry) => entry.company_id === actingProtocolId,
      );
      const revenue = Number(corporation?.last_route_revenue ?? 0) || 0;
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
      );
      setOrSubPhase("Hardware");
    },
    [runGameplayAction, gameId, actingProtocolId, gameState],
  );
  const handlePayDividends = useCallback(
    () => handleDeclareDividendsChoice(true),
    [handleDeclareDividendsChoice],
  );
  const handleWithholdRevenue = useCallback(
    () => handleDeclareDividendsChoice(false),
    [handleDeclareDividendsChoice],
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
          `${buyerTicker} bought ${target.name} from ${ownerLabel} for $${price} -- its own President owned it, so it completed immediately.`,
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
          ? "Targeting mode ON -- click a city hex on the Rail Map to place the token. Click the button again to cancel."
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
      centroidX,
      centroidY,
    }: {
      q: number;
      r: number;
      hexLabel: string;
      centroidX: number;
      centroidY: number;
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
      setPendingToken({ q, r, hexLabel, offsetX: centroidX, offsetY: centroidY });
    },
    [mapGrid, activeStationCompany, gameState],
  );

  /** The green check. THIS is where the token is placed and the treasury
   *  charged -- design note #201. */
  const handleConfirmTokenPlacement = useCallback(() => {
    if (!pendingToken) return;
    const { q, r } = pendingToken;
    setPendingToken(null);
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
      },
    });
  }, [pendingToken, gameId, runGameplayAction, actingProtocolId]);

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
  const handleSkipSubPhase = useCallback(() => {
    /* Design note #278: skipping Routes is the observation that makes a
       stale `last_route_revenue` harmless -- whatever the field says, this
       corporation did not run this turn, so there is nothing to allocate
       and Skip stays available on the Dividends step that follows. */
    if (orSubPhase === "Routes") {
      setRoutesRunThisTurn({ protocolId: actingProtocolId, ran: false });
    }
    runGameplayAction("AdvanceOperatingSubPhase", {
      AdvanceOperatingSubPhase: {
        game_id: gameId,
        protocol_id: actingProtocolId,
      },
    });
    if (!sandbox) return;
    setOrSubPhase((current) => {
      const steps = visibleSubPhases(gameState?.current_global_era);
      const at = steps.indexOf(current);
      // Past the last step the turn is over, so hold rather than wrapping
      // back to Track -- wrapping would let a corporation lay a second tile.
      if (at < 0 || at >= steps.length - 1) return current;
      return steps[at + 1];
    });
  }, [runGameplayAction, gameId, actingProtocolId, sandbox, gameState, orSubPhase]);

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
            ? `${proposal.buyerTicker} bought a ${proposal.modelType}-train from ${proposal.sellerTicker} for $${proposal.price} -- same President, so it completed immediately.`
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

  /** Why this step has no decision in it, or `null` when it does. */
  const autoSkipReason = useMemo<string | null>(() => {
    if ((gameState?.current_round_type ?? null) !== "OperatingRound") return null;
    if (spectator) return null;
    if (orSubPhase === "Routes") {
      return ownsAnyTrain ? null : "it owns no trains, so there is no route to run";
    }
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
    if (orSubPhase === "Dividends" && !ownsAnyTrain) return null;
    if (orSubPhase === "Hardware" && atTrainLimitNow) {
      return "it is already at its train limit";
    }
    return null;
  }, [gameState, spectator, orSubPhase, ownsAnyTrain, atTrainLimitNow]);

  /* Design note #292: the forced withhold. Same once-per-(corporation,step)
     guard as the auto-skip beside it, and for the same reason -- online the
     cursor is poll-driven, so an unguarded effect would broadcast a
     declaration on every render until the next poll landed. */
  const forcedWithholdRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if ((gameState?.current_round_type ?? null) !== "OperatingRound") return;
    if (spectator) return;
    if (orSubPhase !== "Dividends" || ownsAnyTrain) return;
    const key = `${actingProtocolId}:withhold`;
    if (forcedWithholdRef.current.has(key)) return;
    forcedWithholdRef.current.add(key);
    logInfo(
      "Auto-Withhold",
      "No trains ran, so there is nothing to pay out -- $0 withheld and the share price steps left.",
    );
    handleWithholdRevenue();
  }, [
    gameState,
    spectator,
    orSubPhase,
    ownsAnyTrain,
    actingProtocolId,
    handleWithholdRevenue,
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
      `Skipped ${OPERATING_SUB_PHASE_LABELS[orSubPhase].stepLabel} -- ${autoSkipReason}.`,
    );
    handleSkipSubPhase();
  }, [autoSkipReason, actingProtocolId, orSubPhase, handleSkipSubPhase, logInfo]);

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
   * arms the modal, it does not bypass anyone's preferences. */
  const handleEndOperatingTurn = useCallback(() => {
    const viewerIsPresident =
      viewerAddress != null &&
      (gameState?.public_companies ?? []).some((c) => c.president === viewerAddress);
    const isFirstOperatingRound = (gameState?.macro_round_number ?? 0) <= 1;

    handlePassTurn();
    setOrSubPhase("Track");

    if (viewerIsPresident && isFirstOperatingRound) {
      setActiveMainTab("stock");
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
      setMapGrid((current) => applySandboxLayTile(current, q, r, tileId, orientation));

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
    if (spectator) return "Planning Mode: Tile lay disabled -- you are spectating.";
    if (gameState?.current_round_type !== "OperatingRound") {
      return "Planning Mode: Tile lay disabled -- track is laid in an Operating Round.";
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
        ? `Planning Mode: Tile lay disabled -- the turn is still on ${orSubPhase}. Advance to Lay Track first.`
        : `Planning Mode: Tile lay disabled -- this corporation is past the Track step (now ${orSubPhase}).`;
    }
    // `actingSeatIndex` resolves the ACTING corporation's president during an
    // Operating Round, which is exactly the person entitled to lay here.
    const acting = gameState ? actingSeatIndex(gameState) : null;
    if (acting === null || gameState?.player_addresses[acting] !== viewerAddress) {
      return "Planning Mode: Tile lay disabled -- not your corporation's turn.";
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
      // The era comes from `currentPhase.tint`, the SAME derivation the
      // phase badge displays, rather than a second reading of
      // `current_global_era`.
      era: ERA_FOR_PHASE_TINT[currentPhase?.tint ?? "yellow"],
    });
  }, [radialSelector, mapGrid, currentPhase, layTrackFocus?.network]);

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

  const previewRotateArmed = radialSelector !== null && previewTile !== null;

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
  const dividendRevenue = Number(dividendCorp?.last_route_revenue ?? 0) || 0;
  /* Ten shares to a corporation, so a 10% certificate takes a tenth. Floored
     rather than rounded: 1830 pays whole units, and rounding UP would have
     the corporation pay out more than it earned. */
  const dividendPerShare = Math.floor(dividendRevenue / 10);

  /* Design note #278: whether the Pay/Withhold choice is binding. `false`
     when this corporation is known to have skipped Routes -- see the state's
     own note for why `null` (unknown) counts as having run. */
  const dividendRevenueIsThisTurn =
    !(routesRunThisTurn?.protocolId === actingProtocolId && routesRunThisTurn.ran === false);
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

  const dividendPrice = useMemo(() => {
    const cell = marketGrid?.positions.find((p) => p.company_id === actingProtocolId);
    return cell ? Number(cell.price) : null;
  }, [marketGrid, actingProtocolId]);
  const payProjection = useMemo(
    () => projectDividendMove(dividendPrice, "pay"),
    [dividendPrice],
  );
  const withholdProjection = useMemo(
    () => projectDividendMove(dividendPrice, "withhold"),
    [dividendPrice],
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
                {spectator ? (
                  <div style={styles.spectatorNotice}>
                    👁 Watching game #{gameId}. Board, ledger and market are live; every action
                    control is hidden. Join a room from the lobby to play.
                  </div>
                ) : (
                <ContextualActionBar
                  roundType={gameState?.current_round_type ?? null}
                  orSubPhase={orSubPhase}
                  sessionReady={controlsEnabled}
                  // Design note #31: PHASE-APPROPRIATE PASS. `WaterfallPass`
                  // and `PassTurn` are different contract messages, not one
                  // action with two names -- sending the wrong one would
                  // fail with an error about turn state that mentions
                  // nothing to do with passing.
                  onPassTurn={isWaterfallPhase ? handleWaterfallPass : handlePassTurn}
                  passDisabledReason={
                    isWaterfallPhase &&
                    !(waterfallState?.privates ?? []).some((p) => p.bids.length > 0)
                      ? "Passing is illegal until at least one private company has a standing bid."
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
                  privateCompanies={gameState?.private_companies ?? []}
                  privatePowerViewer={viewerAddress}
                  sandboxMode={sandbox}
                  usedPrivateAbilities={usedPrivateAbilities}
                  onUsePrivateAbility={handleUsePrivateAbility}
                  onRunTrains={handleRunTrains}
                  onPayDividends={handlePayDividends}
                  onWithholdRevenue={handleWithholdRevenue}
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
                  routeBuildMode={routeBuildMode}
                  onSelectRouteBuildMode={handleSelectRouteBuildMode}
                  onSelectRouteTrain={handleSelectRouteTrain}
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
                {gameState?.current_round_type === "OperatingRound" &&
                  orSubPhase === "Hardware" && (
                  <TrainPurchasePanel
                    depot={depot}
                    buyer={
                      gameState.public_companies.find(
                        (company) => company.company_id === actingProtocolId,
                      ) ?? null
                    }
                    companies={gameState.public_companies}
                    sessionReady={controlsEnabled}
                    // Design note #2 in `PrivateTradePanel`: a hotseat
                    // sandbox is one human at one wallet, so gating on the
                    // viewer's address would make the whole flow untestable
                    // in the one place it can be run end to end.
                    canAct={
                      sandbox ||
                      (viewerAddress !== null &&
                        gameState.public_companies.find(
                          (company) => company.company_id === actingProtocolId,
                        )?.president === viewerAddress)
                    }
                    blockedReason={
                      trainOffers.some((offer) => offer.buyer_protocol_id === actingProtocolId)
                        ? "One offer at a time -- answer or rescind the outstanding one first."
                        : null
                    }
                    onBuyFromBank={handleBuyTrainsFromBank}
                    onProposeTrade={handleProposeTrainTrade}
                    labelForAddress={(address) =>
                      sandboxPlayerLabel(address) ?? truncateAddress(address)
                    }
                  />
                )}
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
                {gameState?.current_round_type === "OperatingRound" &&
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
                    parValue={srParValue}
                    onSelectParValue={setSrParValue}
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
                    actionsLockedReason={
                      gameState?.current_round_type === "StockRound"
                        ? null
                        : "Viewing only -- shares can be bought and sold during a Stock Round."
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
                      // Design note #199, layer 2: `!tileSelectorArmed` joins
                      // the three mode flags. Outside the Lay Track sub-phase
                      // the interceptor is disarmed entirely, so a stray board
                      // click costs no `GetLegalTilePlacements` round-trip and
                      // cannot open a carousel over a board whose click means
                      // something else.
                      queryClient={
                        !tileSelectorArmed ||
                        routeSelectMode ||
                        tokenTargetMode ||
                        previewRotateArmed ||
                        spectator ||
                        sandbox
                          ? undefined
                          : queryClient
                      }
                      contractAddress={
                        !tileSelectorArmed ||
                        routeSelectMode ||
                        tokenTargetMode ||
                        previewRotateArmed ||
                        sandbox
                          ? undefined
                          : CONTRACT_ADDRESS
                      }
                      gameId={
                        !tileSelectorArmed ||
                        routeSelectMode ||
                        tokenTargetMode ||
                        previewRotateArmed
                          ? undefined
                          : gameId
                      }
                      protocolId={
                        !tileSelectorArmed ||
                        routeSelectMode ||
                        tokenTargetMode ||
                        previewRotateArmed
                          ? undefined
                          : actingProtocolId
                      }
                      cursorMode={tokenTargetMode ? "token" : "default"}
                      onHexClick={
                        tokenTargetMode
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
                      routeOverlays={manualRouteOverlay}
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
                        (tileSelectorArmed && radialSelector !== null) || pendingToken !== null
                      }
                      layFocus={layTrackFocus ?? tokenTargetFocus}
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
          cost={stationTokenCost}
          ticker={
            gameState?.public_companies.find((c) => c.company_id === actingProtocolId)?.ticker ??
            "this corporation"
          }
          canConfirm={controlsEnabled}
          confirmDisabledReason="Initialize the session key to place a token."
          onConfirm={handleConfirmTokenPlacement}
          onCancel={handleCancelTokenPlacement}
        />
      )}
      {/* Design note #199, layer 3: not mounted outside the Lay Track step. */}
      {activeMainTab === "map" && tileSelectorArmed && radialSelector && (
        <RadialTileSelector
          anchorOffsetX={radialSelector.offsetX}
          anchorOffsetY={radialSelector.offsetY}
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
const ACTIVE_GAME_STORAGE_KEY = "18cosmos.active_game.v1";

/* ==================================================================== */
/*  DESIGN NOTE 24: THE THREE WAYS TO BE LOOKING AT A BOARD             */
/* ==================================================================== */
//
//   play     A real on-chain game. `gameId` is the contract's, every
//            control is live, every action signs.
//   spectate A real on-chain game someone else is playing. Live data,
//            no dispatch -- design note #23.
//   sandbox  NO CHAIN AT ALL. The board, tile catalog and picker run off
//            local mock state so the UI can be worked on without a
//            deployed contract, a funded wallet, or a populated Firestore.
//
// Sandbox exists because the lobby was a TRAP. Launching needs a valid
// contract address, spectating needs a game someone already launched, and
// with mock addresses and a fresh Firebase neither is possible -- so there
// was no route from the lobby to `HexGridRenderer` at all. A UI you cannot
// open is a UI you cannot develop.
//
// IMPLEMENTATION NOTE, and the reason this is a mode rather than a magic
// `gameId`. The obvious shape -- `gameId = "offline-sandbox"` -- was tried
// and rejected: `gameId` is typed `number` because it is threaded into
// roughly twenty `ExecuteMsg` payloads as `game_id`, which the contract
// declares as `u64`. Widening it to `number | string` would push a
// `string | number` into every one of those messages and delete the
// compiler's ability to tell a real game id from a placeholder -- the exact
// class of mistake `config.ts` design note #3 exists to catch. So the
// sandbox's identity lives in `mode`, where it is a UI concern, and
// `gameId` stays a number that always means "a room the contract knows
// about". `SANDBOX_GAME_ID` is never sent anywhere; sandbox mode does not
// dispatch.
//
// Sandbox is NOT spectator mode. Spectating disables the tile picker
// (design note #23); sandbox is specifically FOR the tile picker. The two
// are separate flags on purpose -- `spectator` gates dispatch, `sandbox`
// gates whether there is a chain to dispatch to.
export type BoardMode = "play" | "spectate" | "sandbox";

/** The `gameId` handed to the shell in sandbox mode. Never reaches the
 *  chain: sandbox forces `HexGridRenderer` down its offline path, and every
 *  dispatch site is gated before a message is built. `0` because the
 *  contract's `NEXT_GAME_ID` counter starts at 1, so this collides with no
 *  real room. */
const SANDBOX_GAME_ID = 0;

/** The `roomId` handed to the shell in sandbox mode. There is no Firestore
 *  room, so chat and presence both no-op on it. */
const SANDBOX_ROOM_ID = "offline-sandbox";

interface ActiveGame {
  gameId: number;
  roomId: string;
  /** Design note #24. Persisted alongside the ids so a reload cannot
   *  silently promote a spectator into a player -- reading the ids back
   *  without this would default to the most permissive mode and hand a
   *  watcher a playable board. */
  mode: BoardMode;
}

function readActiveGame(): ActiveGame | null {
  try {
    const raw = window.sessionStorage.getItem(ACTIVE_GAME_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as ActiveGame).gameId === "number" &&
      Number.isSafeInteger((parsed as ActiveGame).gameId) &&
      typeof (parsed as ActiveGame).roomId === "string" &&
      (parsed as ActiveGame).roomId.length > 0
    ) {
      const storedMode = (parsed as ActiveGame).mode;
      return {
        gameId: (parsed as ActiveGame).gameId,
        roomId: (parsed as ActiveGame).roomId,
        // Fails CLOSED: only the three known modes are accepted, and
        // anything else -- including an entry written before this field
        // existed -- degrades to `spectate`, the least privileged of the
        // three. The safe reading of "I do not know what this viewer is" is
        // "assume they may not act"; the cost is one trip back through the
        // lobby, versus handing a non-player a board full of live controls.
        mode:
          storedMode === "play" || storedMode === "spectate" || storedMode === "sandbox"
            ? storedMode
            : "spectate",
      };
    }
    return null;
  } catch {
    // Malformed JSON or storage disabled. Falling back to the Lobby is
    // always safe -- it is the screen that can recover from anything.
    return null;
  }
}

/**
 * The boundary between "choosing a room" and "playing in one".
 *
 * With no active game this renders `Lobby`; with one, `AppShell`. That is
 * the whole router -- there is no URL routing here on purpose, since this
 * app has exactly two screens and adding `react-router` for a single
 * boolean would be a dependency and a build-config change (see
 * `config-overrides.js`) bought for nothing.
 *
 * Rendered INSIDE both providers: `Lobby` calls `useWallet()` to sign the
 * launch transaction, so it must sit under `WalletProvider` -- the same
 * nesting requirement `GameSessionContext.tsx`'s own design note #2 records
 * for itself.
 */
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
const PHASE_TINT_STYLES: Readonly<Record<GamePhase["tint"], React.CSSProperties>> = {
  yellow: { borderColor: "#8a6d1f", backgroundColor: "#2a2413", color: "#e0c060" },
  green: { borderColor: "#2f7a4a", backgroundColor: "#12291d", color: "#6fd39a" },
  brown: { borderColor: "#8a5a2f", backgroundColor: "#2a1d12", color: "#d8a070" },
};

const styles: Record<string, React.CSSProperties> = {
  /* ---- Design note #34: the single slim top bar. ----
     `padding` is 6px vertical against the old header's 16px, and the brand
     drops from `display` to `strong`: the point of the consolidation was
     vertical space, so the row has to actually be short or nothing was
     gained by merging. `flexWrap` stays on -- the sandbox phase switcher
     genuinely can overflow on a narrow window, and wrapping is a better
     failure than a clipped Connect button. */
  topBar: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    width: "100%",
    padding: "6px 20px",
    backgroundColor: "#1a1d26",
    borderBottom: "1px solid #2a2e3a",
    boxSizing: "border-box",
    flexWrap: "wrap",
    rowGap: "6px",
  },
  /* ---- Design note #36: the phase badge and its warning. ----
     Both are `flexShrink: 0` and `whiteSpace: nowrap`: the top bar wraps
     rather than clips, and a phase label broken across two lines in a slim
     bar reads as a layout fault. */
  actionBarSpacer: { flex: 1, minWidth: "8px" },
  phaseBadge: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.03em",
    padding: "3px 10px",
    borderRadius: "999px",
    borderWidth: "1px",
    borderStyle: "solid",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  // Design note #7 (`gamePhase.ts`): the shell is shared, the two severity
  // steps below supply the colour. Both read the same `ALERT_*` constants as
  // `TrainBadges.tsx`'s chips, so the bar and the chips cannot escalate to
  // different colours for the same countdown.
  phaseShiftBadge: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.02em",
    padding: "3px 9px",
    borderRadius: "999px",
    borderWidth: "1px",
    borderStyle: "solid",
    whiteSpace: "nowrap",
    flexShrink: 0,
    cursor: "help",
  },
  phaseShiftBadgeWarn: {
    borderColor: ALERT_WARN_BORDER,
    backgroundColor: ALERT_WARN_BG,
    color: ALERT_WARN_INK,
  },
  phaseShiftBadgeCritical: {
    borderColor: ALERT_CRITICAL_BORDER,
    backgroundColor: ALERT_CRITICAL_BG,
    color: ALERT_CRITICAL_INK,
    animation: "app-phase-shift-pulse 1.4s ease-in-out infinite",
  },
  /* Design note #47: muted by default, brightening on hover -- a credit
     should be findable without competing with the game's own chrome. */
  netaCredit: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 600,
    letterSpacing: "0.02em",
    color: "#94a3b8",
    textDecoration: "none",
    whiteSpace: "nowrap",
    flexShrink: 0,
    paddingLeft: "2px",
  },
  topBarBrand: {
    fontWeight: 700,
    fontSize: FONT_SIZE.strong,
    letterSpacing: "0.02em",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  // Pushes the connection cluster right. A spacer element rather than
  // `marginLeft: auto` on the first right-hand child, because which child
  // is first varies (the offline badge and the two error spans are all
  // conditional) and an `auto` margin on a node that sometimes does not
  // render silently un-pins the whole group.
  topBarSpacer: { flex: 1, minWidth: "8px" },
  topBarDot: {
    width: "9px",
    height: "9px",
    borderRadius: "50%",
    flexShrink: 0,
    cursor: "help",
  },
  topBarAddress: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: FONT_SIZE.small,
    color: "#9aa0ac",
    whiteSpace: "nowrap",
  },
  topBarButton: {
    fontSize: FONT_SIZE.small,
    fontWeight: 600,
    padding: CONTROL_PADDING.buttonSmall,
    borderRadius: "999px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#242833",
    color: "#c7cbd4",
    cursor: "pointer",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  // The one call to action in the bar, so it is the one thing in it with a
  // filled treatment.
  topBarConnectButton: {
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    padding: CONTROL_PADDING.buttonSmall,
    borderRadius: "999px",
    border: "1px solid #2f6f6a",
    backgroundColor: "#14312f",
    color: "#7fe0d0",
    cursor: "pointer",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  topBarError: {
    fontSize: FONT_SIZE.small,
    color: "#e07a7a",
    maxWidth: "240px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },

  // ---- Room strip -- design notes #1/#22. Sits between the brand header
  // and the nav tabs, in the same #0F172A recessed tone `TopTicker`'s
  // expanded body and `Lobby`'s panels use, so the two screens read as one
  // application. ----
  // Design note #34: `roomStrip` the container is gone -- its children are
  // inline content in `topBar` now. The `roomStrip*` item styles below are
  // kept because those children still exist and still need their look.
  spectatorNotice: {
    width: "100%",
    padding: "14px 28px",
    backgroundColor: "#1a1710",
    borderTop: "1px solid #3a2f14",
    borderBottom: "1px solid #3a2f14",
    color: "#e0c07a",
    fontSize: FONT_SIZE.control,
    fontWeight: 600,
    boxSizing: "border-box",
  },
  // ---- Global action bar (design note #30). Sits above the phase panel,
  // visually part of the page chrome rather than of either phase's own
  // card layout -- which is the point: these two actions are constant
  // while everything below them changes. ----
  globalActionBar: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    flexWrap: "wrap",
    width: "100%",
    padding: "12px 20px",
    marginBottom: "14px",
    backgroundColor: "#1b2130",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#2f3646",
    borderRadius: "10px",
    boxSizing: "border-box",
  },
  globalActionBarLabel: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.6px",
    textTransform: "uppercase",
    color: "#7f8798",
  },
  globalActionButton: {
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    padding: CONTROL_PADDING.button,
    borderRadius: "8px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#3a4055",
    backgroundColor: "#242c3d",
    color: "#e6e8ef",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  // Inline styles cannot express `:disabled` (Lobby.tsx design note #3), so
  // the disabled look is computed, never assumed.
  globalActionButtonDisabled: { opacity: 0.4, cursor: "not-allowed" },
  globalActionBarHint: { fontSize: FONT_SIZE.small, color: "#8a90a0" },
  // ---- Sandbox phase switcher (design note #25). Violet, matching the
  // sandbox badge beside it, so it reads as part of the debug affordance
  // and never as a gameplay control. ----
  phaseToggleGroup: { display: "flex", gap: "4px", flexShrink: 0 },
  phaseToggleButton: {
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    padding: CONTROL_PADDING.buttonSmall,
    borderRadius: "999px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#4a3a6a",
    backgroundColor: "#1a1424",
    color: "#9a8ab0",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  phaseToggleButtonActive: {
    backgroundColor: "#3a2a56",
    borderColor: "#7a5aa8",
    color: "#e8d8ff",
  },
  sandboxBadge: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.5px",
    padding: "4px 12px",
    borderRadius: "999px",
    backgroundColor: "#2a1e3a",
    border: "1px solid #6a4a8a",
    color: "#c9a8e8",
    flexShrink: 0,
  },
  spectatorBadge: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.5px",
    padding: "4px 12px",
    borderRadius: "999px",
    backgroundColor: "#3a2f14",
    border: "1px solid #6a5a24",
    color: "#e0c07a",
    flexShrink: 0,
  },
  roomStripLabel: { display: "inline-flex", alignItems: "center", gap: "6px" },
  roomStripValue: { color: "#e6e8ef", fontWeight: 700 },
  roomStripDivider: { width: "1px", alignSelf: "stretch", minHeight: "16px", backgroundColor: "#2a3a52" },
  roomStripError: { color: "#f0b0a8", fontSize: FONT_SIZE.small },
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
  //: no container, amber. Reads as a SCORE.
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
    fontSize: FONT_SIZE.heading,
    fontWeight: 600,
    color: "#5fd4c4",
  },
  nativeBalanceDenom: {
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    letterSpacing: "0.06em",
    color: "#7fb3ad",
  },
  offlineBadge: {
    fontSize: FONT_SIZE.small,
    fontWeight: 600,
    padding: "4px 10px",
    borderRadius: "6px",
    border: "1px solid #6b5a24",
    backgroundColor: "#2a2413",
    color: "#d9b95c",
    cursor: "help",
  },
  button: {
    fontSize: FONT_SIZE.strong,
    padding: "9px 18px",
    borderRadius: "8px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#242833",
    color: "#e6e8ef",
    cursor: "pointer",
  },
  errorText: {
    fontSize: FONT_SIZE.body,
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
  /* ==================================================================
   *  DESIGN NOTE 299: THE TABS WERE A HEADING WEARING A BUTTON'S BORDER
   * ==================================================================
   *
   * REPORTED: the main tabs are quite tall and push the chat and activity
   * rows down.
   *
   * They were 14px of padding above and below a `heading`-sized label --
   * the same type step a panel TITLE uses -- which is roughly a 47px
   * control for a one-word destination. The tab bar added another 14px of
   * its own above that, so the row cost about 60px before anything in it
   * had been read.
   *
   * A tab is a navigation control, not a section heading. It takes the
   * `control` step like every other clickable thing in the app, and the
   * padding comes down to a standard compact button. The label is
   * unchanged and still reads at a glance -- what shrank is the empty
   * space around it. */
  mainTabBar: {
    display: "flex",
    gap: "6px",
    padding: "6px 16px 0",
    backgroundColor: "#0F172A",
  },
  /* ---- Design note #46: every tab is visibly a control. ----
     The resting border was `#2a2e3a` against a `#1a1d26` bar -- barely a
     shade apart, so an unselected tab had no edge and read as recessed
     rather than clickable. It is now a crisp slate line on a slightly
     inset fill, which is what makes the row legible as a set of buttons
     before anyone hovers anything. */
  mainTabButton: {
    // Design note #299: `control`, not `heading` -- a tab is a button.
    fontSize: FONT_SIZE.control,
    fontWeight: 600,
    padding: "7px 18px",
    borderRadius: "10px 10px 0 0",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "rgba(51, 65, 85, 0.85)",
    borderBottomWidth: 0,
    backgroundColor: "rgba(15, 23, 42, 0.6)",
    color: "#94a3b8",
    cursor: "pointer",
  },
  /* The active tab is the only WHITE-edged thing in the bar, and the only
     one with a lift. It also keeps `#1E293B` so it still docks seamlessly
     into the panel below (design note #7 in `TopTicker.tsx`). */
  tutorialsButton: {
    padding: "8px 16px",
    borderRadius: "8px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#3a5a8a",
    backgroundColor: "#16202e",
    color: "#9ec5ff",
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    fontFamily: "inherit",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  mainTabButtonActive: {
    backgroundColor: "#1E293B",
    color: "#ffffff",
    fontWeight: 700,
    borderColor: "rgba(255, 255, 255, 0.8)",
    borderBottomColor: "#1E293B",
    boxShadow: "0 -1px 6px rgba(0, 0, 0, 0.35)",
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
    fontSize: FONT_SIZE.control,
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
  /* ---- Design note #31: THE slim bar. Was a tall panel because three
   * trays lived inside it; those are separate blocks below it now, so this
   * is a single row of controls and is styled as page chrome rather than as
   * a card. ---- */
  /* ==================================================================
   *  DESIGN NOTE 297: THE CONTROLS FOLLOW THE PLAYER DOWN THE PAGE
   * ==================================================================
   *
   * The board is taller than the viewport by design (`HexGridRenderer`
   * design note #30 -- the page scrolls rather than the map), which means
   * scrolling to see the southern hexes takes the action panel off the top
   * of the screen. The two controls a player needs while looking at the
   * map -- Place Token, Skip -- are the two that leave first.
   *
   * Sticky rather than fixed: fixed would take the bar out of flow and
   * leave a gap where it was, and it only needs to stop at the top of the
   * scroll container it already lives in.
   *
   * IT CONDENSES WHEN IT STICKS, because a pinned bar is a permanent
   * subtraction from the map. Design note #298 covers what is dropped and
   * why the choice is not arbitrary. */
  actionBar: {
    position: "sticky",
    top: 0,
    zIndex: 50,
    display: "flex",
    // Row, not column: the round label sits inline with the controls now
    // that nothing else shares the container.
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "8px",
    /* Design note #295: the action strip's own height. At 10px vertical
       padding around a 19px control this bar ran past 60px; with the type
       scale at 14px it lands inside the 44-52px band the layout targets,
       and `maxHeight` stops a wrapped row from silently growing past it. */
    padding: "6px 12px",
    backgroundColor: "#1b2130",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#2f3646",
    borderRadius: "10px",
    marginBottom: "12px",
  },
  // Active Player Turn Notifications -- design note #18/item 4. Spread onto
  // `actionBar` alongside its base style, not replacing it, so the bar's
  // own layout/padding/background are unaffected -- only the border color
  // and the shared pulsing-glow animation are added.
  /* Design note #298: the pinned form. Vertical padding halves and the
     bar loses its rounding against the top edge -- it is now a chrome
     element rather than a card, and a floating rounded card that never
     moves reads as a stuck modal. */
  actionBarCondensed: {
    padding: "3px 12px",
    borderTopLeftRadius: 0,
    borderTopRightRadius: 0,
    boxShadow: "0 2px 10px rgba(0, 0, 0, 0.45)",
  },
  actionBarTurnPulse: {
    // Design note #35: crisp silver rather than the old `#c0392b`. Bright
    // enough to read as lit against `actionBar`'s dark fill, and it no
    // longer competes with the auction's red contested ring.
    borderColor: `rgba(${TURN_PULSE_INK_RGB}, 0.75)`,
    animation: "app-turn-pulse-glow 1.6s ease-in-out infinite",
  },
  actionBarRoundLabel: {
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "#9aa0ac",
  },
  actionBarButtons: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: "6px",
    flexWrap: "wrap",
    // Design note #40: must GROW, or the internal spacer has no width to
    // expand into and the phase badge sits flush against Undo instead of at
    // the far right. `minWidth: 0` lets it shrink below its content width
    // too, so a long button row wraps rather than overflowing the bar.
    flex: 1,
    minWidth: 0,
  },
  actionBarButton: {
    // Design note #31: slimmed from `strong`/12px padding. These were sized
    // for a standalone panel; in a single chrome strip they only have to be
    // comfortably clickable, not the focal point of the screen.
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    padding: "7px 14px",
    borderRadius: "8px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#242833",
    color: "#e6e8ef",
    cursor: "pointer",
  },
  // Inline styles cannot express `:disabled` (Lobby.tsx design note #3), so
  // every disabled control computes its own look.
  actionBarButtonDisabled: { opacity: 0.4, cursor: "not-allowed" },
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
  /* Design note #266: twenty `route*` style keys were deleted here along
     with the panel they dressed -- the dashed-border box, the waypoint
     pills, the train chips, the hop counter, the two red warning styles and
     the Auto/Manual pair. They now live in `RoutePlannerPanel.tsx`, next to
     the only markup that ever used them. */
  /* Design note #228: the active-corporation strip. A row rather than a
     boxed card -- it sits directly above the stepper inside a panel that
     already has a border, and nesting a second frame would read as a
     separate widget instead of as this panel's own heading. */
  orContextCard: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "6px 14px",
    /* Design note #299: the strip's height is set by the station-token row
       and the train chips inside it, which are already compact -- so the
       44px floor was adding empty space to a row that had none to give.
       Dropped rather than lowered: a minimum height on a card whose
       contents already exceed it does nothing except on the one screen
       where the card is nearly empty, and there the extra height is not
       worth the pixels everywhere else. */
    padding: "3px 10px",
    borderRadius: "8px",
    backgroundColor: "#171c28",
    border: "1px solid #2b3242",
  },
  orContextIdentity: { display: "inline-flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap" },
  /* `orContextDot` is GONE -- design note #236. The whole bar is the
     corporation's colour now, so a dot of that same colour drawn on it was
     invisible by construction. */
  /* Colours on these five are supplied per-render from
     `corporationBarInk` -- see design note #236. What stays here is
     everything that does not depend on which corporation is acting. */
  orContextTicker: { fontSize: FONT_SIZE.heading, fontWeight: 800 },
  orContextName: { fontSize: FONT_SIZE.small },
  orContextPresident: { fontSize: FONT_SIZE.small, whiteSpace: "nowrap" },
  /* Design note #236: the figures CONTINUE FROM THE LEFT.
     This carried `marginLeft: auto`, which flung them to the far edge of the
     panel. On a wide window that left a gulf between the corporation's name
     and its own numbers, so reading "PRR ... $640" meant crossing the bar,
     and the three figures ended up further from the label they belong to
     than from the window edge. They now flow inline after the identity,
     which is how the sentence actually reads: this corporation, then what it
     has. */
  orContextFacts: {
    display: "inline-flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "6px 18px",
  },
  orContextFact: { display: "inline-flex", alignItems: "center", gap: "6px" },
  orContextFactLabel: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  orContextFactValue: {
    fontSize: FONT_SIZE.strong,
    fontWeight: 700,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontVariantNumeric: "tabular-nums",
  },
  orContextFactAside: { fontSize: FONT_SIZE.micro, fontWeight: 400 },
  orContextFactNone: { fontSize: FONT_SIZE.small, fontStyle: "italic" },
  tokenTargetBanner: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: "10px",
    padding: "7px 14px",
    borderRadius: "8px",
    border: "1px solid #3a5a8a",
    backgroundColor: "#16202e",
    color: "#9ec5ff",
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
  },
  tokenTargetDot: {
    width: "9px",
    height: "9px",
    borderRadius: "999px",
    backgroundColor: "#38bdf8",
    flexShrink: 0,
  },
  tokenTargetCancel: {
    marginLeft: "auto",
    padding: "3px 10px",
    borderRadius: "6px",
    border: "1px solid #4a5163",
    backgroundColor: "#232936",
    color: "#c8cdd8",
    fontSize: FONT_SIZE.small,
    fontFamily: "inherit",
    cursor: "pointer",
  },
  /* Design note #164: the two-row Operating Round panel. */
  /* Design note #299: the gap between the corporation strip, the sub-phase
     stepper and the action row. Three stacked rows at 6px each is 18px of
     pure separation in a panel whose own rows are ~30px -- halved, which
     still reads as three distinct bands. */
  orPanel: { display: "flex", flexDirection: "column", gap: "3px", width: "100%" },
  orPanelStepperRow: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    borderBottom: "1px solid #2b3242",
    // Design note #299: the rule below the strip is the separator; 4px of
    // padding on top of the stepper's own is a second one made of air.
    paddingBottom: "1px",
  },
  orPanelActionRow: {
    display: "grid",
    // THE WHOLE POINT. Equal `1fr` rails mean the centre column is centred
    // on the PANEL, not on the leftovers -- so the action buttons stay put
    // however wide the badges or the utilities grow. `auto` in the middle
    // lets the actions size to their content rather than stretching.
    gridTemplateColumns: "1fr auto 1fr",
    alignItems: "center",
    gap: "10px",
    // Design note #295: a fixed band rather than a floor alone -- the
    // floor was already 44px and nothing stopped the row exceeding it.
    minHeight: "44px",
    maxHeight: "52px",
  },
  orPanelRailLeft: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: "8px",
    flexWrap: "wrap",
    justifySelf: "start",
  },
  orPanelRailRight: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: "8px",
    flexWrap: "wrap",
    justifySelf: "end",
  },
  orPanelActions: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: "8px",
    flexWrap: "wrap",
    justifyContent: "center",
  },
  dividendPanel: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "12px",
    padding: "10px 12px",
    borderRadius: "8px",
    border: "1px solid #2b3242",
    backgroundColor: "#161b27",
  },
  dividendColumn: { display: "flex", flexDirection: "column", gap: "4px" },
  dividendHeading: { fontSize: FONT_SIZE.strong, fontWeight: 800, color: "#e2e6ee" },
  dividendRow: {
    display: "flex",
    flexDirection: "row",
    justifyContent: "space-between",
    gap: "12px",
    fontSize: FONT_SIZE.small,
    color: "#c8cdd8",
  },
  dividendAmount: { fontVariantNumeric: "tabular-nums", color: "#7ee0a1", fontWeight: 700 },
  dividendPct: { color: "#6f7480", fontWeight: 400 },
  dividendNote: { fontSize: FONT_SIZE.small, color: "#9aa0ac", lineHeight: 1.4 },
  dividendMove: { fontSize: FONT_SIZE.small, fontWeight: 700, color: "#9ec5ff", marginTop: "4px" },
  /* Design note #214: the arrow is the one glyph in the line that carries a
     DIRECTION, so it is the one that takes the direction's colour. Sized up
     and weighted past the prices either side of it: those are tinted by
     market zone (a rules fact), and if the arrow merely matched them the
     line would read as three coloured things competing rather than one
     movement between two values.

     `lineHeight: 1` because the diagonal glyphs sit taller than the digits
     and would otherwise push this row's baseline down relative to the
     Withhold column beside it. */
  dividendMoveArrow: {
    fontWeight: 900,
    fontSize: "1.15em",
    lineHeight: 1,
    padding: "0 2px",
  },
  dividendMoveArrowUp: { color: "#4ade80" },
  dividendMoveArrowDown: { color: "#f87171" },
  dividendMoveNote: { color: "#8a90a0", fontWeight: 400 },
  depotSupply: { fontSize: FONT_SIZE.small, color: "#9aa0ac" },
  /* Design note #279: the Track step's "the action is on the map" hint, and
     nothing else. This used to carry a second string saying the step had no
     button at all -- a caption about an empty div, which is exactly what
     that note deleted. An empty centre column is now allowed to be empty. */
  orPanelNoActions: { fontSize: FONT_SIZE.small, color: "#6f7480", fontStyle: "italic" },
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
    fontSize: FONT_SIZE.strong,
    fontWeight: 700,
  },
  hardwareTrayCardCost: {
    fontSize: FONT_SIZE.body,
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
    fontSize: FONT_SIZE.body,
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
    fontSize: FONT_SIZE.body,
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
    fontSize: FONT_SIZE.small,
    boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
  },
  hexClickIndicatorError: {
    backgroundColor: "#2a1414",
    borderColor: "#8a2020",
    color: "#ffe8e8",
  },
  // Design note #141. Amber, and deliberately roomier than the error
  // variant: these messages explain a board rule ("gray hexes are
  // permanently fixed") rather than report a failure, so they run longer
  // and need the width to stay readable at two or three lines.
  hexClickIndicatorBlocked: {
    maxWidth: "320px",
    backgroundColor: "#2a2114",
    borderColor: "#8a6a20",
    color: "#f0dcb0",
    lineHeight: LINE_HEIGHT.normal,
  },
};
