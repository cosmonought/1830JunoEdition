# UI Shell & Layout — Tabs, Ticker, Feed, Styles

The dashboard shell: top-level tabs, the activity feed and its ticker, the fixed bottom dock,
turn notifications, layout un-constraint, and the inline style convention.

Anchors are `<source file> #<N>`. Search the number.

---

## What `App.tsx` is

### App.tsx #382 — What this file stopped being
`App.tsx` was 9,636 lines. A **move-only** extraction took roughly 3,500 of them out: nothing was
rewritten, no logic changed, and every moved declaration kept its own design notes so the history
reads as one file rename rather than a deletion here and an unrelated creation there.

**The rule that decided what left:** a declaration moved out if it was **already self-contained** — if
it closed over nothing in `AppShell` and could be lifted without threading a single new prop.

| Destination | Contents |
|---|---|
| `panels/ContextualActionBar.tsx` | the 1,440-line round-aware control strip, with the four helpers that had no other consumer |
| `components/TopBar.tsx` | wallet/session/room header |
| `components/MainTabBar.tsx` | the tab strip **and** the rules for which tabs exist |
| `styles/appStyles.ts` | the 988-line shared style table |
| `styles/animations.ts` | the `@keyframes` strings |
| `utils/gameConstants.ts` | values that encode a rule |
| `utils/mockFixtures.ts` | values that fake a chain query |
| `utils/routeWaypoints.ts` | the manual route-point vocabulary |
| `utils/activeGame.ts` | `BoardMode` and the stored room pointer |
| `utils/address.ts` | `truncateAddress` |

**What deliberately stayed:** `AppShell` itself, all 5,300 lines of it. Its render tree could be cut
into panels, but every one of those panels closes over 40–80 locals, so the cut costs either an
enormous prop list or a context — and either is a behavioural change wearing a refactor's clothes.
That is a separate pass with a separate risk budget. This one was chosen precisely because it cannot
change behaviour: the code that moved is byte-identical to the code that was here.

### App.tsx (import note) — Two truncators is one too many
`utils/address.ts` carries the version with configurable lead/trail lengths; `utils/lobby`'s
`truncateAddress` would be a name collision. Unifying them is a separate tidy-up.

---

## Tabs

### App.tsx #9 — Four flattened top-level tabs
The previous two-level "Game Board (Rail Map / Stock Market sub-tabs) / Financial Ledger / Rules
Reference" structure became four **sibling** tabs: Rail Map, Stock Market, Financial Ledger, Rules
Reference. The Dashboard Control Bar stays visible across all four. The Activity Feed, Contextual Top
Action Bar, canvas and Contextual Sub-Panel are scoped to Rail Map / Stock Market (both share the same
workspace layout); Financial Ledger and Rules Reference keep their own full-width, canvas-free
layouts.

### App.tsx #17 — "Game Ledger" rename, and Rules Reference wiring
The `"ledger"` tab label changed from "Financial Ledger" to "Game Ledger" — **display text only**; the
source module/component/export name is deliberately unchanged (`FinancialLedger.tsx #5`).

`<RulesReference />` now receives `roundType` and `operatingSubPhase`, values the shell already
computes for the action bar, threaded as two **optional** props (the same "omit to degrade gracefully"
convention as `FinancialLedger.tsx`'s `queryClient`/`contractAddress`/`gameId`) so the tab's "Current
Round Quick Reference" can reflect the room's live round instead of only its static fallback.

### App.tsx #27 — The Rail Map tab just re-rendered the auction screen
`&& activeMainTab === "stock"` is the whole fix. The auction branch sits inside `isWorkspaceTab`,
which is **true for both** the map and stock tabs. So while `isWaterfallPhase` held, the auction
dashboard replaced the workspace on **either** tab — clicking "Rail Map" dutifully set `activeMainTab`
to `"map"` and this ternary rendered the auction anyway, because nothing here consulted the tab. The
tab button worked perfectly and had no visible effect, which is the worst kind of broken.

**Not a sandbox bug.** The sandbox only made it easy to hit, by letting someone sit in the auction
phase indefinitely. In a real game the rail map would have been equally unreachable for the whole
private auction — during which players have every reason to study the board they are about to compete
over.

*(Auto-navigation between tabs on round transitions: see `state_machine.md` `#213` and `#28`.)*

---

## The Contextual Top Action Bar

### App.tsx #8 — One bar, swapped by round type
`ContextualActionBar` sits directly above the canvas on both workspace tabs and swaps its entire
button set on the live `gameState.current_round_type`. Each button maps to a real
`GameplayExecuteMsg` variant already in `sessionKey.ts`'s allow-list — `BuyStock` / `SellStock` /
`PassTurn` / `ExecuteOperatingRound` / `DeclareDividends` / `BuyHardwareFromPool`.

The one exception was "Place Station Token": there is no standalone place-a-station message distinct
from `LayTile`, and `LayTile` needs a specific `(q, r)` the player has clicked. That button was
therefore deliberately **non-dispatching** — it logged an informational entry pointing at the canvas
flow rather than fabricating a fake dispatch or silently doing nothing. *(Superseded by `#159`, which
made it a real mode toggle — see `canvas_rendering.md`.)*

"Undo Last Action" stays available as a small always-visible utility button, independent of round
type. So does "Select Route Points" (`#11`), which is only meaningful on the Rail Map tab.

### App.tsx #4 — Optimistic UI sequencing is the convention
Local UI state is deliberately **not** gated on a chain round-trip; the Action Log entry reports
success or failure independently. `#142`, `#377` and `#378` all cite this convention.

---

## The activity feed

### App.tsx #6 — Consolidated left-side Activity Feed  *[superseded by #18]*
Chatbox and the Action Log used to be two separate panels in a row above the canvas. `ActivityFeed`
merged them into one bordered container — chat on top, the transaction trail underneath, sharing one
scroll region — pinned to the far left of the workspace on both canvas tabs. This also superseded the
previous `Sidebar` "Gameplay Actions" column, whose buttons moved to the Contextual Top Action Bar
(`#8`), so the left edge became single-purpose.

### App.tsx #16 — Activity Log auto-scroll and full-height flex
Three fixes, layout and behaviour only:

1. `styles.actionLog` gains `flex: 1` + `minHeight: 0` so it claims the vertical space available.
   **Flex column layouts need an explicit `minHeight: 0` on a flexed child**, or that child's
   content-based min-height silently overrides the flex-basis and defeats internal scrolling — the
   classic flexbox gotcha. `styles.activityFeed` gets the same treatment one level up.
2. **Auto-scroll upward.** Entries are **prepended** (`setActionLog((log) => [new, ...log])`), so the
   newest is index 0 and renders at the **top**. A `useRef` + `useEffect` keyed on `actionLog.length`
   sets `scrollTop = 0` on a new entry — deliberately the opposite direction from a typical chat log,
   because this list's insertion order is reversed from Chatbox's (`#5` there, whose scroll-to-bottom
   is correct because chat messages are appended).
3. `wordBreak: "break-all"` (needed for unbroken tx-hash strings) was also breaking ordinary readable
   detail text mid-word. Switched to `wordBreak: "break-word"` + `overflowWrap: "anywhere"`, which
   still force-wraps a hash with no natural break point but prefers word boundaries first.

### App.tsx #18 — Full-width canvas, compact ticker, combined feed, turn alerts
**Supersedes `#6` entirely** — the fixed-width (380px) left sidebar is removed from the dashboard grid
outright. Four pieces:

1. **100% full-width main canvas.** With the sidebar gone, `mainRow`'s flex row collapses to just
   `canvasPane`. No change to `HexGridRenderer`/`StockMarketRenderer` — both already fill whatever
   width their parent grants them.
2. **Compact Top Ticker** (`TopTicker.tsx`) — a thin single-line bar below `DashboardControlBar`,
   visible across **every** tab. Previews the most recent item from a chronologically merged
   Chat + Action Log timeline (`utils/feed.ts`'s `mergeFeedItems`), shows an unread badge while
   collapsed, and opens the feed on click.
3. **Combined Feed Overlay** *(superseded by `#20`)* — ALL/CHAT/LOG filter pills over the same merged
   timeline. `chatMessages` state moved up from `Chatbox.tsx` so it could be merged with `actionLog`.
   Every `ActionLogEntry` construction site gained `timestampMs` (`Date.now()`), needed so the merge
   can sort chat and log entries against each other by **real time** — Action Log prepends, Chat
   appends, so neither array's internal order helps. `ActionLogEntry`/`ActionLogStatus` moved to
   `utils/feed.ts` (`#1` there) so both the shell and the feed components share one definition.
4. **Active player turn notifications** — see below.

### App.tsx #20 — In-place accordion, replacing the modal
`FeedOverlay.tsx` is no longer imported or rendered; its filtering, entry rendering and settings moved
into `TopTicker.tsx` and `InlineQuickChat.tsx`, so the feed lives in place rather than in a floating
panel.

1. `isTickerExpanded` (renamed from `feedOpen`) controls the accordion body instead of a mount/unmount.
   `handleCloseFeed` is gone — there is no backdrop or × button, just the header chevron toggling both
   directions.
2. `filteredFeedItems` is `feedItems` filtered by `feedFilter`, now driven by the pills
   `InlineQuickChat` renders. `latestFeedItem` derives from this **filtered** array, so switching
   filters instantly updates both the single-line preview and the expanded history.
3. **Seamless tab docking.** `styles.mainTabButtonActive` and `styles.mainTabBar` share the dark-slate
   palette with `TopTicker`'s header (`#1E293B`) and body (`#0F172A`) — the active tab's background is
   identical to the ticker header beneath it, with matching `borderColor`, so there is no colour seam.

### App.tsx #19 — Ticker refinement
Prominent sizing/typography is internal to `TopTicker.tsx` (`#4` there). `InlineQuickChat.tsx` is an
always-mounted bar directly below the ticker letting a player send a message with zero friction — no
expand click, no modal. It reuses the exact same `chatDraft` / `handleSendChatMessage` threaded into
the other composer: deliberately **one shared draft** (`#1` there), so typing started in one composer
is still there in the other.

### App.tsx #615 / App.tsx #616 — The badge counts chat, not history
**Reported:** the badge tracks messages since a player last opened the log, but in an 18xx game that
reaches thousands if a player never clicks it.

It would, and the deeper problem is that **the number stops meaning anything long before it stops
being true**. A red badge is a **queue** indicator — it promises something is waiting for you and that
opening it clears a debt. Game log entries are not that: they are a record you consult, and nobody is
owed a reading of "PRR laid tile #57 on H10". Counting them produced a permanently angry number a
player learns within one game to ignore, costing the badge its use for the one case that **is** a
queue.

**Chat is that case.** A message from another player is a person waiting for an answer, the count is
naturally small, and clearing it by reading is exactly what the badge claims.

**Counted off `feedItems`, not `filteredFeedItems`.** The filter pills change what the panel
**shows**; they do not change what has **arrived**. A player filtered to "log" who receives three
messages is precisely the player the badge exists for.

**The seen mark moves with it** — `lastSeenFeedCount` now counts chat items, so the two figures are
subtracted in the same units. Mixing them is how an earlier version could go negative when a filter
changed under it, which `Math.max` was quietly absorbing.

`#615`: the history viewport is five rows, not seven.

---

## The bottom dock

### App.tsx #599 — The dock reserves its own height
**Reported:** "When Expanding the chat/activity log, it simply covers the viewport rather than pushing
the viewport up."

`#581` fixed the dock to the bottom edge so it survives scrolling the board, and paid for that with a
constant 96px of padding on the app root — a guess at its height, correct while the dock had one
height and wrong the moment it could grow.

**Measured, not guessed.** A `ResizeObserver` reports the dock's real height on every change and that
becomes the root's bottom padding, so the page is always exactly as long as it needs to be.

**Not `position: sticky`**, which would put the dock in flow and solve this for free. It cannot be: the
app root is a column whose content is frequently shorter than the viewport, and a sticky footer in a
short column sits directly under the content rather than at the bottom of the window — which is where
a status line has to be to be peripheral.

**The observer is the cheap option** despite looking like the expensive one. The alternative is a
table of expected heights per state — a second description of a layout CSS already decides, and the
kind that drifts silently the first time a font or a padding changes.

### App.tsx #605 — Reserving the height is only half of it
**Reported, after `#599`:** "expanding the chat/activity log permanently obscures whatever is at the
bottom of the screen: the expansion should grow the size of the screen."

`#599` makes the content **reachable**. It does not make it **visible**, and those are different
promises. The dock is `position: fixed`, so growing it paints over whatever occupied the bottom of the
viewport; the extra padding lengthens the document underneath but does not move the scroll position.

**The missing half is the scroll.** When the dock grows by N, the page must scroll down by N: the
document just got N longer at the bottom, so scrolling N keeps every pixel of content exactly where it
was on screen and the dock expands into space that was empty. Shrinking runs the arithmetic backwards.
That is what "grow the size of the screen" means in a fixed-footer layout — you cannot push the
viewport, so you move the page under it by the same amount.

**In a layout effect, not in the observer.** Scrolling straight from the `ResizeObserver` callback
races React: the padding that makes the document longer has not been committed, so `scrollBy` clamps
against the **old** document height and under-scrolls by exactly the amount that matters. The delta is
parked on a ref and spent after the commit.

**The first measurement is skipped.** `96` is a seed, not an observation, so the mount-time delta is
the error in that guess — compensating for it would scroll the page on load for no reason a reader
could explain.

**Border box, not `contentRect`.** The dock has a 1px top rule and `contentRect` excludes it, so `#599`
reserved one pixel less than the dock occupies — invisible on its own, and wrong in the same direction
every time this recomputes.

---

## Layout un-constraint

### App.tsx #13 — Page-level scrolling and height un-constraint
Every ancestor of the canvas used to cascade a **hard height ceiling** down from `styles.appRoot`'s
`height: "100vh"`, through `mainRow`'s `flex: 1` / `minHeight: 0`, to `canvasPane` and `boardPane`'s
`overflow: "auto"` — so however large the board content was, it was squeezed into whatever pixel
height the browser viewport happened to have, with overflow trapped behind a tiny internal scrollbar
instead of the page's.

`appRoot`'s `height: "100vh"` is now `minHeight: "100vh"` (still fills at least a viewport, but can
grow to fit real content), and `canvasPane`/`boardPane` both drop `overflow: "auto"`. With no ancestor
imposing a hard height, the column's height is simply the sum of its content's natural sizes — exactly
what `HexGridRenderer.tsx #27` relies on to size the canvas at its true maximum proportional scale —
and the **browser's own page scrollbar** carries a player below the fold.

The Activity Feed's `overflowY: "auto"` (`#6`) and the Action Log's (`#7`) are deliberately untouched:
those are independent, genuinely-scrollable history lists, not a viewport clamped around the board.

### App.tsx #12 — Global dashboard text and layout upscaling
A pure typography/spacing pass across six surrounding control panels — no new components, no behaviour
changes — so the dashboard fills widescreen real estate as comfortably as the canvases already do.
Each upscaled roughly 25–60% past its original small-print sizing:

- Upper Brand Header (`dashboard` / `dashboardBrand` / `statusBadge` / `addressIndicator` /
  `vgpBalance` / `button`)
- Primary Navigation Tabs (`mainTabBar` / `mainTabButton`)
- Activity Feed's Action Log half (`activityFeed` / `actionLogPanel` / `actionLog*`, widened
  300px → 380px)
- Contextual Top Action Bar (`actionBar` / `actionBarButton` / `hardwareTrayCard` / `routePanel*`)
- Stock Market Rule Legend (`StockMarketRenderer.tsx #18`)
- Round Detail Footer (`ContextualSubPanel.tsx #5`)

**Deliberately not touched:** canvas-internal text, which has its own dedicated dynamic-scaling
systems, and `RulesReference.tsx` / `FinancialLedger.tsx`, full-width reference screens outside this
item's scope.

---

## Turn notifications

### App.tsx #18 (item 4) / App.tsx #21 — Mandatory turn alerts
`isMyTurn` drives two independent channels:

- `utils/turnAlert.ts`'s `useDocumentTitleFlash` alternates `document.title` every 1000ms between
  "🚨 YOUR TURN! - Project 18XX" and "Project 18XX", restoring the normal title immediately once it
  goes false.
- A repeating CSS pulse glow (`app-turn-pulse-glow`, a `<style>`-tag keyframes injection using the
  escape-hatch convention `Chatbox.tsx #2` established for this codebase's inline-style convention)
  applies to both a `position: fixed`, `pointerEvents: "none"` viewport-margin overlay and
  `ContextualActionBar`'s outer wrapper — covering "around the top action bar" and "viewport margin"
  in one shared animation rather than two independently-tuned ones.

**`#21`: Notification Settings removed entirely.** Direct feedback: players must not be able to opt
out of turn alerts. `titleFlashEnabled` / `pulseGlowEnabled`, their callbacks, and the two toggle
switches are **deleted** — not disabled, not defaulted differently. Both channels key **directly** off
`isMyTurn` with no intermediate gated value, so "alerts stop as soon as `isMyTurn` becomes false"
falls out of the existing `useEffect` cleanup and the plain `{isMyTurn && …}` JSX guard.

*(The round-type correctness of `isMyTurn` itself is `state_machine.md`, F-5.)*

---

## Seat trail

### App.tsx #639 — Every seat's spendable cash, by address
Back after `#637` removed it, in a smaller form. The trail shows figures on the **inactive** seats
only. A **map** rather than the old array, because the one thing every consumer did with it was `find`
by address once per seat — a quadratic scan for a lookup.

**Both seat-driven rounds, empty otherwise** (`#406`): an Operating Round's turn belongs to a
corporation and its bar draws no seat queue at all.

### App.tsx #610 — Which seats have passed, for the trail's stamps
Two counters, one shape. The Stock Round's rotation is counted by `consecutive_passes` and the
auction's by `consecutive_waterfall_passes`, and **both reset to zero on the first action that is not
a pass** — which is what makes the stamp self-clearing rather than something the shell has to remember
to wipe.

**Suppressed during a mini-auction.** `passedSeatIndices` walks backwards through the **full** seating
order, which is only the running rotation while the main auction is turning over. A mini-auction
rotates over its contestants alone, so the same walk would step across seats that were never asked to
act and stamp them for a pass they were never offered. `WaterfallStateResponse.current_turn` is
documented as not meaningfully moving in that window either.

The Operating Round returns an empty set by falling through: its turn belongs to a corporation, and
the trail is not rendered there.

---

## Styles

### App.tsx (inline styles) — Plain style objects, not a stylesheet
Plain inline style objects rather than a new `App.css` — keeps this milestone a single self-contained
file, matching how it was requested. Swap for a real stylesheet or CSS-in-JS library whenever this UI
grows past a first wiring pass. *(Note: inline styles cannot express `:disabled` — `Lobby.tsx #3`.)*

### App.tsx #36 (phase tints) — Kept beside `styles`, not in `palette.ts`
These are chrome colours on the dark top bar, not card-surface colours. `palette.ts` is specifically
the light-card system, and mixing the two is how a "shared" palette stops meaning anything.

### App.tsx #324 — The phase badge is a label, not an alert
**Reported:** make the base "Phase: Yellow/Green/Brown" badge neutral so only upcoming phase-change
alerts use high-contrast warning colours.

The badge was tinted to match the era, which reads as a colour-coded **status** on a bar where amber
and red already mean "act now": `phaseShiftBadgeWarn` and `phaseShiftBadgeCritical` sit inches away in
the same rail, the same pill shape, the same amber. The permanent label and the two-buys warning were
competing at the same volume, and the warning is the one that has to win — it appears for exactly the
few purchases before a rust, and it is the only badge on the bar a player **must** react to.

Neutral slate for all three. The era is still named in the text, which is what a label is for, and the
era's own colour still appears everywhere it is load-bearing — the tile catalog, the sub-phase
stepper, the board tint. This badge was the one place the colour carried no information the word did
not already carry.

**One record per tint rather than a single style**, so the shape is still there if a future pass wants
a subtle era cue back (e.g. a left border) without re-tinting the whole pill.

### App.tsx #440 (direction-aware hint) — Say which way the step is
The "past the Track step" message was unconditional, which is wrong in the commonest case: from Phase
3 the turn **opens** on `BuyPrivate`, so a player arriving at a fresh Operating Round was told they had
missed a step they had not reached yet — and given no hint that Advance Sub-Phase was the remedy.

### App.tsx #34 — `vgpBalance` and the optimistic-note chain are deleted
Both existed only to feed the top bar's Cash readout, which is gone — in-game cash lives in the Game
Ledger and the Player Index now. The whole optimistic-note chain went with them: `vgpBalanceNote`
state, `runGameplayAction`'s third parameter, and the two notes `BuyStock`/`SellStock` passed into
it. Those two were the only writers and their only reader was the readout just deleted — **a write
path to a value nothing displays is how a "harmless" leftover becomes a puzzle later.**

---

# `utils/actionLog.ts` — Turning a message into a sentence

### actionLog.ts #0 — The log was written for the person who wrote it
Every entry was the contract's own variant name, hand-typed at the call site: `"RunManualRoute"`,
`"BuyHardwareFromPool (mock)"`, `"DeclareDividends: Pay (mock)"`. Three problems, and the third makes the
log useless rather than merely ugly:

- **It named a message, not an event.** "BuyStock" is what the client *sent*. What *happened* is that
  somebody bought a share of something.
- **It leaked the backend.** A player has no idea what `BuyHardwareFromPool` is, and the "(mock)" suffixes
  were notes to a developer about wiring since finished — stale as well as internal.
- **It never said who.** This is the fatal one. In a four-player hotseat with eight corporations, a log of
  twenty entries that names no actor is not a history of the game; **it is a list of verbs.** "Who bought
  that train?" was unanswerable from the one surface built to answer it.

So the label is **derived** from the message and the state it acted on rather than passed in. A hand-written
label at each call site is a second thing to keep in step with the message, **and it was already drifting.**
`runGameplayAction` describes what it is about to send, so a new dispatch site gets a readable line for free
and cannot forget to write one.

### actionLog.ts #1 — The before state is always there
`gameState` is the state **before** the action applies. That is the only state every caller is guaranteed to
have at dispatch time — the reducer has not run yet, and on a live chain the result will not be known for a
block or two. So it is the required argument.

This note originally went on to claim the before-state was also the more **useful** one to report: that
"depot 2/5 remaining" reads as a purchase against the supply it came out of. **That was wrong, and QA caught
it.** A player clicking Buy watches the log to find out what the depot holds **now** — and 2/5 does not
merely answer a different question, **it contradicts the depot panel sitting next to it**, which has already
redrawn to 1/5.

Where a figure only exists after the fact — the exact per-player dividend split, say — it is computed here
from the before-state rather than waited for, because the arithmetic is fully determined by what is already
known.

### actionLog.ts #2 — The resolved state, when there is one
`#1` argued for the before state because it is the only one available at dispatch time. **That holds on a
chain and does not hold in the sandbox**, whose reducer is synchronous — so the resolved state is one call
away and the log was reporting a prediction where it could have reported a fact.

**The distinction that survives is which side of an action a given figure belongs to, and it is not
uniform:**

| Side | Figures |
|---|---|
| **After** | the depot's remaining stock, a treasury balance — the reader wants to know where things stand now |
| **Before** | what a thing **cost**, which corporation acted, who held what — facts about the action rather than its consequences |

Both are available and each figure takes the one that fits. `undefined` on a live chain, where the
before-derived phrasing stands. Reading the resolved state rather than subtracting one from the old one also
means **the log cannot disagree with the depot panel about what is left** — both ask `depotInventory` of the
same state.

### actionLog.ts #478 — The step is part of what passing means
**Reported:** passing in an Operating Round logs "[Player] passed the turn"; it should read "[Corporation]
passed [step]" — "PRR passed Lay Track".

**Two separate errors sat in that one sentence.**

- **The wrong actor.** An OR is corporation-driven: the queue names companies and the human is only whoever
  presides over the one that is up. Naming the president in a log of corporate actions **puts a different
  kind of noun in one line of a column that is otherwise all tickers**, and in a hotseat where one player
  presides over three companies it does not identify which one passed.
- **The missing object.** "Passed the turn" is true of every pass, so a run of them is a run of identical
  lines. What a reader wants to know is **what was declined** — track, a token, a route — because that is
  what explains the corporation's position later.

**The step cannot be derived here.** The contract persists a sub-phase cursor but the client's own copy
(`orSubPhase`) is the one that says which step the button was pressed **from**, and it is not part of
`GameStateResponse`. So it is passed in, and stays **optional**: a caller without one gets the shorter
sentence rather than a guessed step — the same rule `#2` applies to `afterState`.

`actingEntity` is the distinction `actingPlayer` cannot make, and **every OR line that named a human was
making the same mistake.** Exported because `App.tsx` needs the same answer when it records what an Undo
would revert.

For `AdvanceOperatingSubPhase`, "skipped a step" had the right actor and the wrong amount of information —
**it is the one message whose whole content IS which step, and it was the only part left out.** The cursor
has not moved at dispatch time, so `orSubPhase` is still the step being declined.

For `PassTurn`: in an OR the Pass button ends the **corporation's** turn from whatever step it is standing
on, so both facts belong in the sentence. **Outside one, `PassTurn` really is a seated player passing** and
the original wording is correct — there is no corporation to name and no sub-phase to be on.

### actionLog.ts #554 — A purchase is a price
**Reported:** the line should say what the share cost.

**It is the one figure a reader of the log actually wants.** "P1 bought a 10% share of ERIE from the IPO"
tells you a thing you probably watched happen; what you cannot reconstruct afterwards is what it cost — and
in a game where the same share sells at par from the IPO and at market from the pool, **the price is what
distinguishes two otherwise identical lines.**

**From the message first.** `par_value` travels **in** the purchase (it is what founds the corporation), so
an IPO buy can be priced from the action itself rather than from any client's view of the board — the
property `#553` is about. A pool buy has no such field and falls back to the chart, the right source for a
market price.

**Silent when unknown, rather than "$0" or "$?".** A live chain computes the price server-side and this
client may genuinely not know it; **a sentence that omits the cost is honest, and one that invents a figure
for the log is worse than the omission it replaces.**

### actionLog.ts #434 — The dividend projection is keyed by company, not by price
It took a **price**, and the projection then had to find a cell by searching for that price — which on a
chart that repeats prices across rows found the wrong one, **so this log quoted a destination the token
never went to.** The caller looks the corporation's real `(x, y)` up instead.

### actionLog.ts #361 — Privates are known by number as well as name
**Reported:** the log prints "Schuylkill Valley" where it should print "1. Schuylkill Valley".

The auction cards have been numbered 1–6 since `#304`, on the reasoning that **1830 players refer to these
companies by waterfall order as much as by name** — "the 3" is how a table talks about the Delaware &
Hudson. The log was the one surface still using bare names, **so a player reading back what happened had to
translate between two vocabularies.**

**One helper, used by every arm that names a private**, so the log cannot develop two formats. Falls back to
the bare id when the room does not report the company — `#307`: "private #3" is the contract's identifier and
means nothing at the table, but it is still better than `undefined`.

### actionLog.ts #479 — Online, the client does not know what it undid
The sandbox names the reverted action from its own history; **a live chain resolves undo itself, a block or
two later, so naming an action here would be a guess printed as a fact.** It names the actor and stops.

### actionLog.ts (null return) — No sentence beats a worse sentence
`describeGameplayAction` returns `null` when a message has nothing worth reporting beyond its own name,
**rather than a generic fallback**: the caller keeps its own label for those, and a sentence that says less
than the variant name would be a downgrade dressed as an improvement.

---

# `utils/feed.ts` — The merged timeline

### feed.ts #1 — `ActionLogEntry`/`ActionLogStatus` moved here from `App.tsx`
Same shape, plus exactly one new field — `timestampMs`, a real sortable epoch alongside the existing
display-only `timestamp` string. Moved so both `App.tsx` (which still constructs these) and `mergeFeedItems`
(which sorts them against chat messages) **share one definition instead of two independently drifting
copies.**

### feed.ts #2 — Real sortable timestamps, not insertion-order guessing
Both `ActionLogEntry` and `ChatMessage` already carried a display-only `toLocaleTimeString()` string **with
no reliable sort key**. `timestampMs` is what `mergeFeedItems` actually sorts by, so the combined timeline is
genuinely chronological **even though the two source arrays use opposite insertion conventions internally**
(Action Log prepends, Chat appends).

Merged **oldest-first**, matching ordinary chat reading order, since the feed auto-scrolls to the bottom on
new arrivals.

### feed.ts #3 — Icon matching was a label-substring lookup  *[deleted by #425]*
Every `ActionLogEntry.label` is a human-readable string set by `App.tsx`'s handlers, and `iconForLogEntry`
read that same string to classify it into one of five badge categories, falling back to a generic icon rather
than mis-tagging.

### feed.ts #425 — The emoji helpers are gone
`iconForLogEntry` and `iconForLogStatus` were **deleted, not merely left uncalled.** They produced the
category badges and status circles `TopTicker` used to prefix every log line with, and the requirement is
that the log carry clean text and nothing else.

**Why delete rather than stop calling.** Two exported functions whose entire output is emoji, sitting in the
module the log renders from, are **a standing invitation to put the badges back** — and the category one
deserved removing on its own merits regardless: **it inferred a type by substring-matching the label**, so it
restated a word already visible in the sentence beside it and mis-tagged any entry containing another
category's keyword ("Skip Station Token" is a Tile; "Private Revenue" is Stock).

`ActionLogStatus` is unaffected and still carried on every entry — `TopTicker` reads it to mark a failure **in
words**. **The status was never the problem; rendering it as a coloured circle was.**

### feed.ts #343 — The round is stamped, not derived
The round context an entry happened in — "Auction", "SR1", "OR 1.1" — is **stored on the entry** rather than
computed when the log is rendered, **and the difference is the whole point.** A derived prefix reads the
**current** round, so the moment the auction ended every historic line would relabel itself "SR1" and the log
would claim the privates were auctioned during the Stock Round. **A log that rewrites its own history is
worse than one with no prefixes at all.**

Optional, so entries written before this field existed render without a prefix rather than with an empty
bracket.

### feed.ts (chat id) — Widened from `number` to `string | number`
Chat is no longer a local counter — it is a Firestore collection, and the identity of a message is its
**document id**, which is a string. **Deriving a number from that string would be strictly worse:** a hash
can collide, and a counter is per-client, so the same message would carry different ids in different
browsers — **exactly the wrong property for the value React uses as a list key.** Nothing downstream needed
changing: `mergeFeedItems` only interpolates it into a template string, and ordering has always come from
`timestampMs`.

### feed.ts (F-8 purge) — `ChatMessage` and `truncateChatAddress` moved here; `Chatbox.tsx` deleted
Two reasons, one practical and one about layering:

- **The `Chatbox` component itself was dead.** It had not been rendered anywhere since its state was hoisted
  into `App.tsx` and its UI replaced by `TopTicker`'s accordion plus `InlineQuickChat`. Only the type and the
  truncation helper were still live, so the file was ~200 lines of unreachable React kept alive by two small
  exports.
- **The dependency ran the wrong way.** `utils/feed.ts` is a pure domain module and it was importing a type
  out of `components/` — **utilities depending on the view layer, which is backwards and is what made the
  dead component look load-bearing.**

### feed.ts (author colours) — A fixed palette hashed by identity
Deterministic per-author colour tag, **not a random or session-only assignment**, so the same author reads as
the same colour across every render and every reopen — the same "fixed palette keyed by identity" convention
`StockMarketRenderer.tsx`'s `TICKER_COLORS` established for corporation tokens.

---

# The Contextual Action Bar — `ContextualActionBar.tsx`

The strip that swaps its controls to match the live round type and Operating Round sub-phase. Moved out
of `App.tsx` unchanged. Its **economic** notes — dividends, trains, privates, pockets — live in
[contract_economy.md](contract_economy.md); the market-move line is in
[stock_market.md](stock_market.md).

### ContextualActionBar.tsx (file header) — Why `panels/` and not `components/`
At 1,440 lines this was the single largest extractable block in `App.tsx`, and **the clearest case for a
`panels/` directory rather than `components/`: this is not a reusable widget but one named region of the
game screen, assembled from widgets that DO live in `components/`.** The distinction is worth a
directory, because it tells the next reader which files they may freely reuse and which are one-of-a-kind
surfaces.

**What travelled with it, and why each belongs here rather than in a shared module** — each had exactly
one consumer, and that consumer is in this file:

| moved in | why |
|---|---|
| `ActionBarButton` | the shape of one button in this bar; nothing else constructs one |
| `useCondensedOnScroll` | exists solely to collapse THIS bar when the page scrolls (`App.tsx #268`) |
| `ZonedPrice` | renders one market price with its zone tint; used only by `MarketMoveLine` |
| `MarketMoveLine` | the dividend projection line, used only by this bar |

Leaving any behind would have meant `App.tsx` exporting a helper solely so this panel could import it
back — **the shape that makes a monolith structural rather than incidental.** Nothing else changed: same
props, same order, same branches, same comments.

## One bar, and what it replaced

### ContextualActionBar.tsx #31 — One bar, everywhere
This is the app's **only** action bar, and it renders on every active tab. Two separate bars existed:
this one (chunky, inside the workspace, carrying the OR buttons plus Undo) and a slim `GlobalActionBar`
at the top of the phase tab for Pass/Undo. **On the phase tab during a Stock Round BOTH rendered, one
above the other, with two Undo buttons** — because the phase tab falls through to this component's branch
as well. `GlobalActionBar` is deleted; this component absorbed Pass, kept Undo, and was restyled slim.

**Pass is phase-routed, and this is the part worth not getting wrong:** `WaterfallPass` and `PassTurn` are
**different contract messages, not one action with two names.** The caller decides which; this component
renders the button and shows `passDisabledReason` when passing is illegal (the waterfall forbids it while
no bid stands anywhere).
**The three trays below are not part of the bar.** The hardware marketplace, the Buy Private Company tray
and the route-point readout used to sit inside the bar's own container, which is most of what made it
"chunky" — **they are panels, not buttons, and one of them contains a price slider.** They render under
the slim strip as their own blocks, each narrowly conditional, so most of the time none renders at all
and the bar is the entire control surface.

### ContextualActionBar.tsx #29 — Dead props are not free
`onBuyShare`/`onSellShares` are no longer props of this component at all. Buy/Sell live entirely in
`StockRoundPanel`'s corporation cards, so there is never a duplicate control surface — but the props were
kept in the interface after the controls moved out, unused, "to keep this a minimal-footprint change".
**Then their signature changed to take a company id, and four call sites failed to typecheck for a prop
nobody reads.** Dead props are a type error waiting for the real implementation to move.

### ContextualActionBar.tsx #500 — The ticker leaves the bar entirely
`#482` removed the one-line activity echo from the **pinned** form and left it in the expanded one,
ending on the sentence "the honest next step is to take it out altogether." `#500` is that step.
`TopTicker` is mounted at the top of the app with the same feed, the same filter and an accordion for the
history; **a one-line echo of its newest entry, inside the panel a player uses to ACT, spent a row of the
one surface whose rows are contested to repeat something already on screen.**
`latestFeedItem` and `onOpenActivityLog` go with it rather than being left as unused props: **a prop with
no reader is how the line comes back.** `App.tsx` keeps `latestFeedItem` — `TopTicker` is its real
consumer and always was.

### ContextualActionBar.tsx #510 — A jump button with nothing to jump to
`#491` added a "Buy Trains" jump because the purchase panels sat far below a pinned bar. `#508` moved
those panels **into** the bar, so they travel with it — **and a button whose only job was to scroll to
something that no longer goes anywhere is a control with nothing left to do.**

## The three-column grid

### ContextualActionBar.tsx #164 — The Operating Round panel is two rows
It used to be one long wrapping strip: Pass Turn, a divider, every action for the current sub-phase,
another divider, Undo, the route toggle, a spacer, the phase badge, the shift warning. On a narrow window
that wrapped — and **because the number of contextual buttons CHANGES with the sub-phase, the badges moved
every time the turn advanced. A warning that relocates as the game progresses is a warning players stop
tracking.**
Now: a stepper row, then an action row laid out as a **three-column grid, `1fr auto 1fr`.** The centre
column holds the sub-phase actions and is **genuinely centred on the panel, not merely centred in whatever
space the sides left over**, because the two `1fr` rails are equal by construction however wide their
contents get. Badges dock left, always-available utilities dock right, and neither can push the actions
off-centre.
**The four "Skip" buttons are gone.** `Skip Track Lay`, `Skip Private Purchase`, `Skip Tokens` and
`Skip Routes` all called the exact handler the stepper's own "Advance Sub-Phase" button calls — **four
names for one action, one of them present in every phase**, which is what made the action row read as a
pile of controls rather than "what can I do here". **Advancing is a property of the TURN**, so it lives
with the stepper; the action row holds only things that change game state.

### ContextualActionBar.tsx #482 — A `1fr` track refuses to shrink below its content
**Reported:** the activity ticker pushes the action buttons off-centre in the collapsed bar.
It did, **and the mechanism is worth recording because the row was BUILT not to allow it.** The row is a
`1fr auto 1fr` grid precisely so the centre column is centred on the panel (`#426`) — but **a `1fr` track
is `minmax(auto, 1fr)`: it refuses to shrink below its content**, so a rail holding a long unconstrained
line of text does not get clipped, it **grows, and takes the centre column with it.** The sibling rail on
the non-Operating-Round bar has carried `minWidth: 0` for exactly this reason since `#458`; this one never
did.
Two fixes, both wanted: the rail gets its `minWidth: 0`, **which makes the centring structural rather than
dependent on what happens to be in the rail** — and the ticker is gone from the pinned form outright.

### ContextualActionBar.tsx #654 — The grid had three columns and two children
**Reported:** "the Action Buttons and the 'Phase' badge [are] in [a] weird place. The 'Phase' badge should
be flush left and the Action buttons should be center."
`#426` describes the `1fr auto 1fr` grid working — **and it never did, in this branch.** Only **two**
children were put in it, so the buttons took column one, the badge took column two, and **a whole `1fr`
column sat empty off the right edge.** That is the reported "weird place".
`#426`'s own note says "the rail renders unconditionally so the grid always has three columns" — **true of
the RIGHT rail it was written about; never made true of the left one.** `actionBarRailLeft` is defined in
`appStyles.ts` and this file had never referenced it. **A grid does not report a missing child — it shifts
everything one column over and renders something plausible.** Same family as the phantom style key: the
layout is stated in one file and half-performed in another.
The order is now the instruction's: phase leads, buttons centre, and **the trailing rail is empty and
unconditional** — it exists only so the centre column has equal weight either side.

### ContextualActionBar.tsx #540 — A divider needs something on both sides
**Reported:** two bars appear between Pass Turn and Undo Last Action.
They are these two, with nothing between them. The pair frames `contextualButtons`, and **that array is
EMPTY in several real states** — an auction round, a Stock Round with no corporation selected, and (the
case that surfaced it) a room whose game has not been dealt. **Two separators with no content between them
read as a rendering fault, which is exactly what they are: a rule divides things, and there was nothing to
divide.** Gated on the group they frame rather than on any particular round, so every empty case is
covered by the condition that actually describes the problem.

### ContextualActionBar.tsx #258 / #263 — Skip is an action, so it sits with the actions
`#235` moved Skip onto the action **row** for the right reason — it is the alternative to whatever this
step offers — **but dropped it into the right RAIL, the docked-utilities column.** In a `1fr auto 1fr`
grid anything in that rail is pinned to the far edge: **Skip ended up flush right, half a panel away from
the buttons it is an alternative to.** It sits in the centre column now, **last in the group**: declining
is the fallback, so it reads after the things it is a fallback to rather than competing for the first
glance.
**#263 — except on the last step, where it is a twin.** Buy Trains is the final sub-phase and already
carries "End Turn". **Skip and End Turn there are the same gesture wearing two labels**: nothing follows
Buy Trains, so "move past this step without acting" IS "finish this turn". **Two buttons for one outcome
is worse than a redundant control — it implies a distinction**, and a player who reads one has to work out
what the other would do differently. So Skip is hidden on `Hardware`; every earlier step keeps it, because
there it genuinely does something End Turn does not — move one step and leave the rest of the turn intact.

### ContextualActionBar.tsx #279 — No placeholder where a control should be
This row used to fall back to "No button for this step — use Skip to move on." whenever a sub-phase
contributed no contextual buttons. `#180` wrote it to replace an even worse string, **and it kept that
string's central mistake: it describes the PANEL rather than the player's options.** Every step of an
Operating Round has something to do, and a line saying otherwise was only ever true of one `div`.
**It also aged badly.** By the time the Run Routes controls had moved into their own panel, `Routes` was
the only step reaching this branch — **so the one place the string actually rendered was a step with a
whole route planner directly beneath it, telling the player there was nothing here but Skip.**
Deleted outright, with the Routes controls moved onto the line so the branch has content rather than a
caption about its absence. **The Track hint survives because it is the opposite kind of string:** it says
where the action IS (on the map), which is a thing the player cannot otherwise know.

## Identity: whose turn, and what they have

### ContextualActionBar.tsx #228 — Whose turn is it, and what do they have
A player presiding over three corporations had no single place telling them which one is acting. The
information existed — the Round Detail table highlights the active row, the roster carries treasuries —
**but both are elsewhere on the page, and the action bar, which is where every decision is actually made,
named no company at all.** So the commonest question in an Operating Round ("am I spending PRR's money or
NYC's?") required looking away from the controls that spend it.
**Four facts, chosen because each gates a decision on this very bar rather than because they were
available:** treasury (caps every action in the turn), stations (how many tokens are left and what the
next costs — the Tokens step's whole decision), trains (what can run in Routes, and what the limit permits
buying in Hardware). Rendered as a strip **above** the stepper: **it describes the whole turn, and the
stepper describes where in that turn you are.**

### ContextualActionBar.tsx #236 — The bar wears the corporation's colour
**The colour is the identity now.** This was a fixed dark navy with a small brand-coloured dot — the same
slab for every corporation, so telling PRR's turn from NYC's meant reading the ticker. The bar takes the
**exact palette the station tokens on the map are drawn from**, so the strip and the tokens the player is
placing are visibly the same company. A player running three corporations can tell whose turn it is
peripherally, which is the whole complaint.
**The dot went with it.** A brand-coloured dot on a brand-coloured bar is invisible, and it was only ever a
miniature of the signal the bar now carries at full size.
**Ink is derived, not asserted.** `bestContrastTextColor` is the same per-fill choice the map's tokens make
for their acronyms, so B&M's dark slate gets white text and C&O's orange gets black without either being
hardcoded — rather than this asserting white and being wrong on C&O.
**Secondary text is the same ink at reduced alpha, never a fixed grey.** A grey that reads as "quieter" on
PRR's dark red is nearly invisible on C&O's orange; **alpha over the actual background holds its
relationship to whatever is behind it.** (`#631` factors the same rule out, because the seat card needs it
too: a grey that reads as quieter on slate blue is nearly invisible on ochre.)
**No corporation → the neutral dark this bar always had.** That state is reachable before the first
`GetGameState` resolves, and colouring it from a fallback grey **would dress an empty bar as though a
company were acting.**

### ContextualActionBar.tsx #575 / #589 / #410 / #465 — The bar names a corporation the way the card does
**#575 — reported:** the herald and the full name are on the bar, but not the acronym. They were on one
baseline-aligned row, **so the acronym appeared only as `CorporateLogo`'s text fallback — which is to say
only when the artwork failed to load.** `StockRoundPanel.tsx #465` had already settled the argument and its
reasoning applies unchanged: **"a herald is unmistakable once you know it and unreadable until you do"**,
and the full name "is what you read second". `PRR` is what a player says out loud.
So this **mirrors `rosterIdentityRow` exactly** — herald and acronym sharing a row, full name beneath.
**Not a similar arrangement: the same one**, because the bar and the card name the same object and a player
should not have to learn two layouts for it.
**#410:** the same herald the Stock Card stripe shows, so a corporation is not a logo on one screen and an
acronym on the other. `null` has no logo to draw — **there is no corporation, which is a sentence rather
than a missing image.**
**#465 — beside, not instead.** The logo's own text fallback would double the ticker when a file is
missing — only in the failure case, **and a doubled ticker is a better failure than a nameless bar.**
**#589 — two lines, not three.** *Reported:* the president became a third row, making the card taller than
it needs to be — a side effect of `#575` turning a baseline-aligned row into a column. **It belongs beside
the full NAME**: both are identity detail read second ("the Pennsylvania Railroad, Ada presiding" is one
thought), while the herald and acronym above are the label you read first.

### ContextualActionBar.tsx #570 — The bar wears whose turn it is
**Reported:** players do not find the Action panel especially visible during the Auction and Stock Rounds —
and, unprompted, that they DO find it easy to see during an Operating Round.
**That pairing is the answer.** An Operating Round bar carries the acting corporation's livery as a
full-height block of colour, **and a block of colour is what makes a panel findable at a glance.** The two
seat-driven rounds have no corporation, so the bar falls back to the same dark chrome as everything around
it and stops being a distinct object.
They do have an acting **player**. `#569` gave every seat a colour; this spends it — same mechanism, same
meaning, extended to the rounds that were missing it rather than a new decoration invented for them.
**A stripe, not a fill.** The corporation's livery fills a card because an Operating Round turn is *about*
that corporation. A Stock Round turn is not about the player in the same way — they are choosing among
eight companies — **so the seat's colour runs as an edge rather than taking over the panel. Enough to
locate, not enough to claim.** `null` outside those rounds, so an Operating Round cannot end up wearing two
identities at once.

### ContextualActionBar.tsx #631 — The seat card, built like the corporation card
**Reported:** "the Action bar during stock and auction rounds now have a long player color-ed stripe along
the top, but users are still not seeing it or finding it very intuitive what it does."
Both halves are right and the second explains the first. **A 3px stripe can only signal that SOMETHING is
the case; it cannot say what.** The Operating Round bar does not have that problem because it does not use
a stripe — its context card is a fully-saturated block carrying the corporation's acronym, name and
figures, **and a player reads WHO from it without being taught that colour means anything.**
**So this is that card, with a seat in it.** Same construction: the identity's own colour at full strength,
ink chosen by `bestContrastTextColor` rather than asserted, a translucent black border so one rule darkens
any hue. **Nothing here is a new idea; it is the existing idea applied to the round that was left out.**
**The figures are labelled, which is the other half of the report:** 'the compressed "P1 $500 (+$200)" made
some players think they were earning $200'. **That reading is entirely fair — a bare "+$200" beside a
balance is the notation a game uses for income.** Escrowed money is the opposite: the player's own cash,
already committed, unavailable until the bid resolves. **A plus sign cannot carry that and no amount of
tooltip fixes a glyph people do not hover.** So the card spends the width on words — "Cash" and "In bids".
**The stripe stays.** It is the handoff animation (`#597`), which is about the moment of change rather than
the state, **and the card cannot do that job — a card that is always there cannot sweep.**

### ContextualActionBar.tsx #636 — The same three rows as an Operating Round
**Instructed:** "why not exactly replicate the Operating Round's Action bar layout? top row is: Auction/
Stock Round X, Player Name > Player Name > …, the second row is the player card…, and the third row is the
center Pass or Undo buttons?"
Taken as written. The Operating Round is a **column**: identity card, then a `1fr auto 1fr` action row.
This branch was a single action row with the seat card wedged into its left rail — **so the card competed
with the buttons for width instead of sitting above them, and the two rounds put the same object in two
places.**
**On the objection raised alongside it** — that "players are different from corporations and it may not be
right to have them displayed the exact same way" — **the difference is real and it is not in the LAYOUT.**
What differs is what the track contains: an Operating Round's trail is one corporation's progress through
its own turn, while the seat trail is the whole table's rotation. Those are different scopes and they read
differently in the same slot, which is fine and even useful. **What a player learns from the
standardisation is where to LOOK** — round on the first line, who is acting on the second, what they can do
on the third.
**The phase badge stays in the action row's right rail**, exactly as the Operating Round keeps its
utilities there: it is chrome about the game rather than about this seat.
**#309:** Pass and Undo were left-aligned here while the Operating Round's controls are centred, **so
switching rounds moved the buttons across the screen and muscle memory built in one phase missed in the
next.** A leading spacer balances the trailing one that pins the phase badge.

### ContextualActionBar.tsx #601 — The roster pills were unreachable
Deleted: a `playerRoster.length > 0` branch rendering one pill per seat, plus eight styles and a keyframes
block. **Roughly forty lines of render that could not execute.**
**Why it could not.** `#595a` left the pills "for every case the trail does not cover", **which sounded
careful and described an empty set.** `playerRoster` is computed in `App.tsx` behind
`current_round_type === "WaterfallAuction" || === "StockRound"` (`#406`) and returns `[]` otherwise — **and
that is the SAME test that decides whether `seatOrderTrail` is passed at all.** So the two conditions are
one condition: any time the roster is non-empty the trail is non-null, wins the `??`, and the pills never
render. **There was no third case.**
**The lesson is about the shape of the guard, not the pills.** Two conditions written in two files, each
true exactly when the other is, **read like a fallback and behave like dead code — and nothing flags it,
because it compiles and lints perfectly.**
What the pills knew lives on: `#342`'s "the whole table, not just whoever is up" and `#317`'s "AVAILABLE
cash, not the total" are both carried by `SeatOrderTrail`. **The acting-player badge is now the only
fallback** — it covers the Operating Round (whose turn belongs to a corporation, so it has no seat queue)
and every non-sandbox room until the first `GetGameState` resolves.

### ContextualActionBar.tsx #545 — What the mini-auction chase animation meant
The one thing genuinely lost with the pills (`#601`). **The multicolour chaser was chosen for a running
mini-auction because green is reserved for "on turn in the ordinary rotation", and a mini-auction SUSPENDS
that rotation — so painting a contestant green would assert the one thing that is not true.**
It also drove the **greyed-out** pills, via `isSidelinedByMiniAuction` (`utils/gameState.ts`), which states
a real fact about the game rather than a visual one: **these players cannot act, and cannot be acted for,
until the contest resolves.**
The chaser itself is not lost — **it still rings the contested card in `WaterfallAuctionDashboard.tsx`
(`#320`/`#344`), which is where it came from and where it is still read.** `SeatOrderTrail` draws the seat
queue and says nothing about mini-auction membership; if that turns out to matter, this note and the
dashboard's are the two to read before reinventing it.

## The round label and the sub-phase trail

### ContextualActionBar.tsx #339 — The auction is a round, and the bar said it was not
`roundType` has four values and this branch covered two, so **the Waterfall Auction — the phase every game
opens in — fell through to "No live round" while the auction dashboard was on screen beneath it. A
player's first impression of the app was a header denying that anything was happening.** `null` keeps the
honest wording: before the first `GetGameState` resolves there genuinely is no round yet.

### ContextualActionBar.tsx #517 — Which Operating Round this is
"Operating Round" alone named the **kind** of round in a game that runs several back to back — so a player
checking which one they were in, or reading a log line about "OR 3.2", **had nothing on the panel to match
it against.** `macro_round_number` and `sub_round_index` render as "3.2", the board's own notation and the
same pair `ContextualSubPanel` prints.
**Passed rather than derived**, because this bar has no game state: it takes a `roundType` and a sub-phase
and knows nothing about round numbering. `null` before the first poll resolves, **which keeps the bare
"Operating Round" wording rather than printing a placeholder pair.**

### ContextualActionBar.tsx #481 — The stepper row was a row for one word
**Reported:** two Undo buttons when expanded, and the sub-phase takes an entire unnecessary row.
**Both were the same row.** It held the six-chip progress strip and, in its trailing slot, a second Undo —
`#235`'s reasoning, sound when written and **untrue underneath it** once `#451` put Undo in the action
row's right rail with the sub-phase name next to it, for the same reason. **Two notes, one argument, two
buttons.** `#451`'s placement wins because it sits with the other turn controls.
**The strip is now a phrase.** It rendered five or six chips, chevrons and step numbers across the full
width to say "you are on step 2 of 5, called Lay Track" — **which is a sentence, and now reads as one**,
inline beside the round title. All three facts survive; what is gone is a horizontal rule and 30-odd
pixels of height, permanently, on the panel above the board.
**Also removed: the "Phase N of 6" suffix, and its removal is the point rather than a simplification.**
The stepper numbers from the steps this era actually has — five in the Yellow era, six from Phase 3 —
while the label numbered from the fixed six-entry table. **So the bar read "Phase 2 of 6: Track" directly
above a strip whose first chip said "1 Lay Track": two different numbers for the same step, six inches
apart.** Reconciling them would mean two places computing one position; **the honest fix is for one of them
to stop making the claim.** `visibleSubPhases` is what this file needs from the stepper component now — the
same era/privates filtering — so the count reads "2 of 5" in the Yellow era and "2 of 6" from Phase 3.
**The component is kept intact rather than deleted**, because it is a correct self-contained rendering of
the turn sequence and `RulesReference.tsx` is the natural home for one. What is honestly lost: the chips
named the steps that come **next**, so a newcomer could read the whole sequence off the bar.
**It survives the collapse, unlike the strip it replaces.** `#298` dropped the stepper when pinned on the
grounds that it is orientation rather than input; **neither objection survives the change of form** — at
three words it costs the board nothing, **and it is now the ONLY thing naming the current step in the
header**, so dropping it when pinned would leave a scrolled player unable to tell Lay Track from Station
Tokens. Operating Round only: there is no sub-phase sequence in a Stock Round or the auction, and a step
counter beside those titles would be **inventing structure the round does not have.**

### ContextualActionBar.tsx #518 — The trail, when there is room for it
**Reported:** replace the bare sub-phase string in the expanded header with a horizontal list of every OR
sub-phase as connected boxes, active one emphasised. Keep the compact string when collapsed.
This restores what `#481` removed, **and the reason it is not a reversal is the CONDITION.** `#481`
replaced the strip because it cost a row **in every state including the pinned one**, and `#298`'s rule is
that a pinned bar must earn every row. **That argument is about the PINNED form and was applied to both.**
So the two forms split rather than one replacing the other: the expanded panel shows the whole trail —
which answers **"what is still to come"**, a question a bare label cannot — and the pinned form keeps
`#481`'s phrase, which answers **"where am I"** in three words. Neither state gains a row it was not
already spending.
**The counter goes with the trail.** "4/6" beside six visible boxes is the same redundancy the round
label's note objects to. The compact form keeps it, because there it is the only thing carrying the
position. Both forms measure against **the same `visibleSubPhases` result**, so the trail and the counter
cannot disagree about how many steps this era has.

### ContextualActionBar.tsx #630 — Both rounds put their track in the same place
**Instructed:** "let's make sure the player order track moves to the same place as the subphase tracker in
the Operating Round."
It was in the **button** row, beside Pass and Buy, because that is where the roster pills it replaced had
sat (`#342`) — **and a pill carrying a player's spendable cash genuinely did belong next to the controls
that spend it. `SeatOrderTrail` is not that.** It answers "where are we in the rotation", **which is the
same question the sub-phase trail answers for a corporation's turn**, and the two were being answered in
different halves of the same panel.
So it moves up, directly under the round label. **A player learns one place to look for "how far through
are we"** and it holds whichever track this round has — steps in an Operating Round, seats in the other
two. **The two are mutually exclusive by round type, so this costs no height.**
**And the money is no longer why it is there:** `#631`'s seat card carries the acting player's figures
beside the controls, which is the part of `#342`'s argument that was about proximity to the buttons. The
trail keeps every seat's cash for comparison, which is the part that was about the table.

### ContextualActionBar.tsx #144 / #212 — The stepper is read-only, and Skip is a real message
`#144`: Skip dispatches the real `AdvanceOperatingSubPhase`. **Every skip is an on-chain, replayable
event** — the old client-only `setOrSubPhase` calls advanced the UI while the contract's cursor stayed
put, which under G-14 enforcement would have desynced the bar from what the chain would accept.
`#212`: the strip is a **read-only indicator in every mode now, sandbox included.** Its only control is
Skip. See that component's `#1` for why **a clickable sandbox strip made the one place that tests the turn
order unable to test it.**

## Pinning and scroll

### ContextualActionBar.tsx #298 — What a pinned bar is allowed to keep  *[reversed by #590]*
A sticky bar costs the map its height for the whole scroll, **so the pinned form has to earn every row it
occupies.** The rule applied was: **keep what a player needs WHILE LOOKING AT THE BOARD, drop what they
only need when deciding what to do next.**

| | |
|---|---|
| **kept** | the phase badge, the acting corporation, its treasury and train limit, and every action button — the inputs to "can I click that hex" |
| **dropped** | the station-token row, the president's name, the train chips and the sub-phase stepper — all orientation, answering "where am I in the turn" |

### ContextualActionBar.tsx #372 — The pinned card shows the pieces
**Reported:** scrolled down, the sticky card shows the name, the treasury and the train limit. During
operations the actual trains and stations matter far more than the cap.
`#298` **dropped the two rows that were expensive in height** — the station circles and the train chips —
keeping the cheap single figures. **That optimised for pixels rather than for the decision:** a president
mid-turn is asking "what do I own and where can I put a token", and the answer was scrolled off the top of
the page while a number they cannot act on stayed pinned. So the condensed card keeps the **pieces** and
drops the **limit** — the one figure a president cannot act on, since the Buy Trains step enforces it on
its own.

### ContextualActionBar.tsx #498 — Except during Run Routes, which IS the board
**Reported:** during Run Routes the collapsed panel does not give enough context about the active trains.
**It gave none.** `#298`'s rule is right and Run Routes is the step where it misfires: **everything about
this step IS the board** — which train is being drafted for, what its run is worth, whether the other two
have routes at all. `RoutePlannerPanel` carries all of it and scrolls away.
So this row is the exception `#298`'s own reasoning asks for, **and it is narrow: condensed only, Routes
only, one line.**
**The chips are live, not a readout.** They call the same handlers the planner rows do, so from the
collapsed bar a player can still switch which train the map is drafting for and light its route up. **A
dead label would have shown the problem without giving anywhere to act on it.**

### ContextualActionBar.tsx #590 — Nothing is dropped when pinned
**Reported:** "I am not sure any of the information from the fully expanded version needs to disappear…
removing items for the sake of removing them makes the information that disappears (presidency, train
limit) seem less important than the other items, but since there's room players might as well see it all."
**The premise of `#298`/`#372` was that space was scarce. It is not, at the widths this is actually played
at — and the cost of the rule is worse than the space it saved: a player who learns that presidency and
train limit vanish under pressure reasonably concludes they matter less, which is the opposite of true for
the train limit especially.**
So the pinned bar shows the same facts as the expanded one. **If a narrow window ever makes this genuinely
tight, the answer is wrapping or a smaller type scale, not deciding for the player which facts they may
keep.**

### ContextualActionBar.tsx #480 — Measure the panel, not the page
This was `window.scrollY > 24` — see `utils/stickyCollapse.ts` for why that **collapsed the bar while it
was still sitting in the middle of the viewport with nothing to gain by it.** The hook now hands back a
**ref** as well as the flag, because the question it answers is about a specific element and cannot be
answered without one. Both root branches attach it; only one is ever mounted, so there is no contention.
**The rAF is kept and matters more than it did.** The old body read one number off `window`; this one calls
`getBoundingClientRect`, **which forces layout** — doing that on every pixel of a wheel gesture is the
difference between a cheap scroll handler and a janky one, so the read is coalesced to at most one per
frame.
**`resize` is listened to alongside `scroll`**, because a window resize can reflow everything above the
panel and **move its pin line without the scroll position changing by a pixel.** The sticky offset is
re-read then too — a media query is entitled to change it.

### ContextualActionBar.tsx #597 / #597a — The handoff band
**#597 — the continuous pulse stays and is now the quieter of two cues.** It says "it is still your turn" —
a sustained state, correctly rendered by a sustained animation. **The band's sweep says "your turn just
began", which is the arrival the report is about and the thing a continuous animation can never carry.**
**`key` is the mechanism, not a React formality.** Changing it on every new acting seat makes React
**replace** the element, which **restarts** the CSS animation — so the sweep fires once per handoff and
then stops. Without the key the element would persist and the animation would run exactly once, on mount,
for the whole game. **Keyed on the SEAT, not just the colour:** colour is unique per seat today and would
work, **but it is a proxy for identity, and a proxy that silently stops being one** (a seventh player, a
duplicate pick) **would leave the sweep never firing with no visible cause.** The name is what actually
changed.
`aria-hidden`: it decorates a fact the bar already states in words, and a screen reader announcing a colour
change on every turn would be noise.

**#597a — `sticky` is already a positioned element.** *Reported:* "the Action bar no longer travels down
the screen as the player scrolls."
That was one line. The previous pass added `position: relative` so the band could pin itself to the top
edge — **and the comment even claimed it did so "without the bar's own sticky positioning being disturbed",
which is exactly what it disturbed.** `relative` replaced `sticky` outright, so the bar stopped following
the scroll on every round with an acting seat.
**It was never needed. `position: sticky` already establishes a containing block for absolutely positioned
children**, so the band pins to the bar with no help. **The override bought nothing and cost the one
behaviour the bar exists to have.**

## Authorisation and redirects

### ContextualActionBar.tsx #413 — The bar now asks whose turn it is
**Reported:** during an Operating Round the acting corporation's president is locked out of Lay Tile, while
every player who is NOT acting can see and click Skip.
**Both halves at once, which is what makes it look contradictory and what gives it away:** the
authorisation was not merely wrong, it was **absent** from one surface and **correct-but-starved** on the
other.

- **The lockout** was `actingSeatIndex` returning `null` because `active_operating_order` was empty — see
  `sandboxSession.ts #411`. "Nobody may act" is the correct reading of an empty queue, and the tile-lay
  gate correctly refused everyone including the president. **Fixed at the source; nothing in this file
  caused it.**
- **The Skip button is this file's.** Every control was gated on `sessionReady` alone — **"is there a
  signing session", not "may this player act"** — so a bar rendered for a spectator or for the four players
  waiting their turn carried live buttons that dispatched real messages. The chain would refuse them, but
  only after a signature and a round trip, **and the sandbox has no chain to refuse anything.**

**`isMyTurn` was already computed, already correct, and already passed to this component — and used for
exactly one thing: a decorative pulse on the wrapper. The predicate the bar needed was sitting in its own
props being used as a CSS class.**
**Hidden, not disabled, and that is a departure from how this file treats every other unavailable control.**
A disabled button with a reason is right when the player COULD act and something specific stops them
(`#293`'s End Turn). **It is the wrong shape for "this is not your turn"**, because there is no action to
take, nothing the player can change, and **eight greyed buttons on four players' screens is an entire panel
of noise describing somebody else's decision.** The acting corporation is already named across the top of
the bar; that is the answer to why the controls are absent, and it is already on screen.
**Scoped to Operating Rounds**, because that is the round whose turn belongs to a corporation rather than a
seat, and the round this bar carries action buttons in. The Stock Round and auction put their controls in
their own panels, so widening this would gate a set that is already empty while risking the auction's flow.
The Track hint is gated the same way: **told to a non-acting player it is an instruction they cannot follow,
on a map that will refuse them — the same dead click, dressed as help.**

### ContextualActionBar.tsx #390 / #404 — One button, and nothing else
When the player is on any tab other than the one this round is played on, **the entire bar is replaced by a
single control that takes them back. Replaced rather than prefixed**, and that is the requirement's word: a
bar showing the redirect *alongside* the usual buttons would leave live controls for a round being played
on a screen the player cannot see, **which is how you get an action dispatched against a board you are not
looking at.**
**#404 — this now covers the reference tabs too** (Ledger, Rules, the market chart). They used to be exempt
so that reading did not cost a player their controls; **playtest found the cost of the exemption, which is
that Pass and Undo sat live on a screen nobody was acting from and turns were being spent by accident.**
**The replacement is what makes the reversal safe.** A reference tab keeps an action bar — so the player
stays oriented and the layout does not jump — **and that bar has exactly one control, which cannot end a
turn.**
**The copy distinguishes the two cases.** Standing on another round's *playing* surface is a player who may
be waiting for something that will never happen there; standing on a reference tab is a player who is
deliberately reading. **Same button, different sentence.** `null` when the player is where the action is,
or is on a reference tab with nowhere to send them — **`onSelectTab` is part of the condition because a
redirect button with nothing to dispatch is a dead end, not a fix.**

### ContextualActionBar.tsx #33 — The route toggle is a run-trains tool, not a global one
`Routes` is this UI's name for the contract's run-trains sub-phase (`OPERATING_SUB_PHASE_LABELS.Routes`
renders as "Run Trains", mirroring `or_phase::OR_PHASE_ORDER`). **Sketching a route is only meaningful
while a corporation is about to run one**, so that is the only time the toggle exists.
`#11` argued the toggle was "harmless to leave on" outside that phase. **It was not, for two reasons that
only show up in use:**

1. **It silently disarms the map.** Leaving route mode on rewires the Rail Map's click handling — the
   `queryClient`/`contractAddress`/`gameId`/`onHexClick` props are all switched to `undefined` while
   `routeSelectMode` is true. **A player who flipped the switch during Routes, moved to Track next turn and
   clicked a hex to lay tile would get a route point and no tile picker, with nothing on screen explaining
   why.**
2. It advertised a control for a phase the player was not in, on the Auction and Stock Round tabs where
   there is no train to run at all.

**Hiding the button alone would have left hazard (1) intact** — the mode would just become unreachable
while still ON. So the owning component **force-clears `routeSelectMode`** whenever this condition goes
false.
`#279` also moved the toggle here from inside `RoutePlannerPanel`, where it sat above a table of drafted
routes and **read as a property of those routes rather than as the tool that makes them.** It sits
immediately before Skip because **those two ARE the choice on arriving at this step: pick how to build a
route, or decline to build one.**
`#266`: the Auto/Manual pair likewise left the docked-utilities rail — **they are not utilities, they are
the first step of the Run Routes task** — and now head `RoutePlannerPanel` as one segmented control. That
panel renders on the whole `Routes` sub-phase rather than only while route mode is engaged: **the old panel
was gated on `routeSelectMode`, which made the toggle that turns route mode on live somewhere else by
necessity — a control cannot switch on the panel it is inside.**
The toggle used to render in the non-Operating-Round branch too, where its own flag made it **unreachable
markup. Removed rather than left as a second copy to keep in step with the live one.**

## Undo

### ContextualActionBar.tsx #451 — Undo, and what it would undo
**Reported:** add Undo to the collapsed/sticky bar so it is always accessible, and put the sub-phase name
beside it so the logic of what is being undone is visible.
Undo lived only on the non-Operating-Round branch — **the auction and Stock Round row. During an Operating
Round, which is the round with the most undoable actions in it and the only one with sub-steps to get lost
in, the button was simply absent.**
**The pair is the point, not two controls that happen to be adjacent.** `Undo` alone answers "can I take
that back"; `Track ⟲ Undo` answers **"take back what I did in Track"**, which is the question actually being
asked. `#439` made Undo rewind past auto-skipped steps to the last thing the player chose — **so naming the
step it will land on is what makes that behaviour legible rather than surprising.**
It sits in the right rail, which the grid keeps clear of the centred group, **so adding it moves nothing:
the primary buttons stay exactly where muscle memory left them.**

### ContextualActionBar.tsx #592c — One Undo button, not two
The previous pass gave the host a second "Undo Round" control, arguing that taking back a whole round is a
different decision from taking back one action.
**Instructed otherwise, and the instruction is better:** "Can the Host's Undo button simply reverse through
every player's actions? We can include a note in the tutorial." **A host who presses Undo four times has
taken back four actions and knows it — the button says what it will take back each time. A second control
asked them to decide, before pressing anything, how far they intended to go, which is not how anybody uses
undo.**
So there is one button. It steps back one action at a time, and **for the host that step may land in
somebody else's turn.** The reason it cannot fire is shown on the button rather than left to a dead click.

### ContextualActionBar.tsx #592d — Undo is not a move, so it is not turn-gated
**Reported:** "the Host's Undo power needs to be effective at all times: currently it only works on their
turn."
`sessionReady` is `controlsEnabled && isMyTurn`, so Undo wore the same gate as Buy and Pass. **That is
exactly backwards for this control: the player who most needs it is the one whose turn has just passed to
somebody else, and the host's whole reason for having a longer reach is to fix a mistake that is no longer
theirs to fix on their own turn.**
**One reason string is the whole gate.** `undoBlockedReason` is non-null whenever Undo cannot fire —
read-only mode, nothing to undo, or somebody else has acted since your last move — and the button shows it.
**A boolean plus a separate message would be two things to keep in step, and the failure would be a disabled
control explaining why a different control is disabled.**

## Short notes and cross-references — `ContextualActionBar.tsx`

Several numbers cited in this file's remaining comments belong to notes that live with the component
they describe. They are listed here so the number resolves from this file's namespace.

| cited as | belongs to |
|---|---|
| `#4` | `RoutePlannerPanel.tsx #4` — why the builder refused the last map click |
| `#7` | `utils/gamePhase.ts #7` — the one severity decision, shared with the train chips |
| `#9` | `TrainPurchasePanel.tsx #9` — transient, and NOT the active train |
| `#14` | `App.tsx #14` — the Buy Private Company action tray, already filtered |
| `#18` | `App.tsx #18` (item 4) — active-player turn notifications |
| `#275` | `App.tsx #275` — one priced draft per owned train, the roster not the model set |
| `#293b` | `App.tsx #293b` — "owns none" is not "we were not told" |
| `#329` | `utils/gameState.ts #329` — a corporate private pays into the treasury each OR |
| `#362` | `StationTokenRow.tsx #362` — the home slot shows its hex |
| `#379` | `utils/gameState.ts #379` — the corporate-private account |
| `#406` | `App.tsx #406` — when `playerRoster` is computed at all |
| `#410`, `#465`, `#552` | `StockRoundPanel.tsx` — the herald, the acronym beside it, and the shipped crown |
| `#486` | `App.tsx #486` — the dividend declaration used for the dispatch |
| `#569` | `App.tsx #569` — every seat gets a colour |
| `#573b` | `App.tsx #573b` — why the last exchange refused |

### ContextualActionBar.tsx #47 — Hover and focus states inline styles cannot express
The credit's interaction states are computed rather than declared, for the same reason every disabled
control in this codebase computes its own look: inline style objects have no pseudo-classes.

### ContextualActionBar.tsx #159 — Whether station-token targeting is armed
The armed flag and its target, threaded from the shell — the bar renders the control, the shell owns
the map interaction it arms.

### ContextualActionBar.tsx #181 — The price is on the button
What a station token costs **this** corporation, on the control that spends it. The cost is not flat
(`utils/stationTokens.ts #0`: free, then $40, then $100), so a button that named the action without
its price named half of it. Compare `#237`, which drew the whole allowance rather than a fraction.

### ContextualActionBar.tsx #297 / #298 — Pinned to the top, so the bar sheds its chrome
`#297` is the sticky positioning itself; `#298` is the rule for what the pinned form keeps.

### ContextualActionBar.tsx #373 — The shared route cursor, owned by the shell
The bar renders the toggle; the cursor state lives above it, because the map and the planner panel read
the same value. See `#33` for why the owner force-clears it.

### ContextualActionBar.tsx #375 — Interactive only during Run Routes
The condensed route chips accept clicks in the one step where a click means something. Outside it they
would arm a mode the player is not in (`#33`).

### ContextualActionBar.tsx #407 — Revenue shown, not hovered
The figure is rendered rather than left to a tooltip — the same argument `#651` makes for the market
chart's legend and `#490` for the payout table: a fact a decision turns on does not live behind a hover.

### ContextualActionBar.tsx #442 — Keyed by ACTION, not by private id
A private can offer more than one power (the D&H's is the example), so keying by id would collapse two
distinct actions into one control.

### ContextualActionBar.tsx #493 — Re-run the tracer. An action, not a mode.
Distinguished from the Auto/Manual toggle (`#266`), which selects **how** a route is built. Re-running
is a one-shot command and is shaped like one.

### ContextualActionBar.tsx #494 — The per-train route ink
So the collapsed chips match the colours the map draws each train's route in — one palette, read by both
surfaces, rather than a second table that can drift.

### ContextualActionBar.tsx #595 / #595a — The seat-order trail, for the two seat-driven rounds
`#595` introduced `SeatOrderTrail`; `#595a` kept the roster pills "for every case the trail does not
cover", which turned out to be an empty set. See `#601`.

### ContextualActionBar.tsx #613 — `Buy Private` shows in Phases 3 and 4 only
The sub-phase exists earlier in the turn order (`trading.rs` puts private purchase first), but the
**step** is only reachable in those phases, so the button follows the phase rather than the ordering.

### ContextualActionBar.tsx #623 — `RunRoutesButton` joins the step's finishing action to the bar
The finishing action for Run Routes rides on the bar alongside the planner's own controls, so the step
can be completed from the pinned form (`#498`'s reasoning, applied to the button rather than the chips).

---

# The shared style table — `styles/appStyles.ts`

### appStyles.ts (file header) — A move, not a rewrite
Every declaration here is the same object literal `App.tsx` carried at the bottom of the file, in the
same order, with the same comments — so `git log -p` on a style reads as one continuous history rather
than a deletion and an unrelated creation.
**Why it moved.** `styles` alone was 988 of `App.tsx`'s 9,636 lines and is read by five components
(`TopBar`, `MarketMoveLine`, `ContextualActionBar`, `MainTabBar`, `AppShell`). **A table with five
consumers is shared infrastructure, and shared infrastructure that lives inside one of its consumers
forces every other consumer to import from that consumer — which is how a file becomes a hub that
cannot be split.** `PHASE_TINT_STYLES` rides along because separating it from `styles` would put two
halves of one lookup in two files.

### appStyles.ts #34 — One slim top bar
6px vertical padding against the old header's 16px, and the brand drops from `display` to `strong`:
**the point of the consolidation was vertical space, so the row has to actually be short or nothing was
gained.** `flexWrap` stays on — the sandbox phase switcher genuinely can overflow, and wrapping is a
better failure than a clipped Connect button. `roomStrip` the container is gone; its children are
inline content in `topBar` now, and the `roomStrip*` item styles survive because those children do.
**The right-hand cluster is pushed by a spacer element, not `marginLeft: auto` on the first right-hand
child** — which child is first varies (the offline badge and two error spans are all conditional), and
an `auto` margin on a node that sometimes does not render silently un-pins the whole group.

### appStyles.ts #13 (layout un-clamping) — `minHeight`, not `height: 100vh`
A hard `100vh` clipped the whole column to one viewport-worth of pixels no matter how tall the board
needed to be. `minHeight` keeps the "fills the viewport on a short screen" look while letting the
column grow, **so the browser's own page scrollbar carries the rest instead of an inner pane's.**
`overflow: "auto"` is likewise dropped from `canvasPane` and `boardPane` — that was the cramped inner
frame window. `StockMarketRenderer` still gets its pane height from the same un-clipped flex chain;
only the Rail Map's canvas actually grows past one viewport in practice.

### appStyles.ts #600 — `flex: 1` means `flex-basis: 0`, and that is the bug
**Reported, twice:** "the Action bar no longer travels down the screen as the player scrolls." The
first fix (removing a `position: relative` that had overridden `sticky`) was a real bug and not this
one.

**A sticky element travels only within its PARENT'S BOX.** This pane is the bar's parent, and `flex: 1`
expands to `1 1 0%` — **a flex-basis of ZERO**, grown to fill the flex line. In a column whose container
is `min-height: 100vh`, that line is one viewport tall. So the pane computed to roughly the viewport
height while its content ran far past it and simply overflowed. **The bar was sticking perfectly: it had
a few pixels of parent to stick within, reached the bottom of that box, and scrolled away with it.**
**Why the auction showed it first:** the effect scales with how far the content overruns the pane, and
the auction stacks six private cards, the action bar and a row of player cards on one tab. The fault
was present everywhere and simply had less to give it away.
`1 0 auto`: still grows to fill a short page, but **its basis is now its CONTENT**, so it is never
shorter than what it holds. `flex-shrink: 0` because a pane that shrinks below its content is the state
this note is about.
**Not verified in a browser, and worth saying:** this is reasoned from the flex spec. Three earlier CSS
causes were checked and ruled out first (no `overflow` on any ancestor, no `position` override, no
competing stacking context) — **but if the bar still fails to travel, this note is the next thing to
disbelieve.**

### appStyles.ts #299 / #456 / #46 — The tab row
**#299 — the tabs were a heading wearing a button's border.** 14px of padding above and below a
`heading`-sized label is roughly a 47px control for a one-word destination, and the bar added another
14px, so the row cost about 60px before anything in it had been read. **A tab is a navigation control,
not a section heading** — it takes the `control` step like every other clickable thing.
**#456 — the tab row had no escape.** *Reported:* the Tutorials button overflows its container. The row
is a flex line with no `flexWrap` and no `minWidth: 0` on its children, and Tutorials is pinned right
past an `auto` margin. **Flex items refuse to shrink below their content width by default, so once the
labels exceed the bar nothing gives — the row runs past its own padding and the item on the far side of
the auto margin is the one that visibly leaves.** `flexWrap` is the fix and `rowGap` is what makes it
survivable; bottom padding goes `0 → 6px` because the original assumed exactly one line.
`flexShrink` plus `minWidth: 0` on the Tutorials button is what actually lets it give way before the row
breaks — **without `minWidth: 0` a flex item will not shrink below its content.**
**#46 — every tab is visibly a control.** The resting border was barely a shade from the bar, so an
unselected tab read as recessed rather than clickable. The active tab is the only white-edged item and
the only one with a lift, and it keeps `#1E293B` so it docks seamlessly into the ticker below it
(`TopTicker.tsx #7`).

### appStyles.ts #297 / #426 — Sticky, and what stopped it behaving like it
**#297:** the board is taller than the viewport by design, so scrolling to the southern hexes takes the
action panel off screen — and the two controls a player needs while looking at the map (Place Token,
Skip) are the first to leave. **Sticky rather than fixed:** fixed would take the bar out of flow and
leave a gap where it was, and it only needs to stop at the top of the container it already lives in.
**#426 — plain `sticky top-0`.** *Reported:* the bar should only collapse when it actually reaches the
top. `position: sticky; top: 0` was already there; **what stopped it behaving that way was
`marginBottom`. A sticky element's margin travels with it**, so the bar reserved 12px of empty space
beneath itself for the whole scroll and detached from the viewport edge 12px early. The margin moves to
the content that follows, which is where the gap was wanted.
`zIndex: 50` stays: **sticky does not create a stacking context on its own**, and without it the panels
scrolling underneath paint over the bar at exactly the moment it is doing its job.

### appStyles.ts #426 / #654 — True-centred, which the spacer pair was not
**Reported:** true-centre the action buttons. The row was a flex line with a `flex: 1` spacer either
side of the group, and `#309` described that as centring.
**Two equal spacers do centre the group BETWEEN THEMSELVES. They do not centre it on the bar**, because
the phase badge sits outside the trailing spacer and the leading spacer has nothing balancing it — so
the group is pushed left by exactly the badge's width, and by more when the badge escalates to its
wider alert wording. **The buttons drifted as the phase text changed, which is the tell.**
`1fr auto 1fr` is the same grid the Operating Round row has always used and is immune to that.
**#654 — lead and trail, not left and right.** The badge is flush left now, so the rails are named for
position rather than side: one carries the phase group, the other **carries nothing and exists to be
the third grid column.** An empty element as layout is worth defending because it looks like something
to delete: **it is a grid TRACK, not a flex spacer of the kind `#426` removed. Delete it and the centre
column becomes the last column.**
**`minmax(0, 1fr)` rather than bare `1fr`:** a `1fr` track still has an `auto` minimum, so a rail whose
content is wider than its share grows past half and drags the centre off true. **The explicit `0` floor
lets the rails shrink and keeps the middle middle.** (`#482`/`#458` are the same fix, one bar over.)

### appStyles.ts #295 / #655 — A ceiling on a wrapping row has no version that is right
**#295** set the strip's height so a 19px control lands inside the 44–52px band the layout targets.
**#655 — reported** at Run Routes: "there's a horizontal rule that looks like 'Run Routes' is supposed
to be above, but instead the rule is bisecting the Phase marker, the Run Routes button, and the Undo
button, while C&O's four train chips below are not enclosed in the action panel and bleed onto the map."
**One cause, two symptoms.** `maxHeight: 60px` capped the row's BOX, not its contents. Routes is the
busiest step, so the centre column wraps to a second line and the real content runs past 60px — and
with no `overflow` set, **that surplus paints outside the box.** The rule is the next row's `borderTop`,
and that row is a SIBLING laid out at this row's *declared* bottom edge while the buttons are still
being drawn below it. **The chips were never mispositioned; they were positioned relative to a boundary
that lied.**
`#426` named this exact failure while keeping it — "a `maxHeight` that no longer fits its contents is
how a bar starts clipping its own controls" — and raised the number instead of removing the cap.
**The FLOOR is what `#295` actually wanted:** a band the row never falls below, with `alignItems:
center` keeping the contents centred in whatever height results.

### appStyles.ts #619 — A `Record<string, T>` style sheet cannot catch a phantom key
**Reported,** of Buy Trains: "if a corporation MUST buy a train … the 'End Turn' button needs to be
grayed out." **It already refused the click** (`#293` disabled it three passes earlier). What it did not
do was LOOK refused.
`ContextualActionBar` reached for `styles.actionButtonDisabled`. **The key here is
`actionBarButtonDisabled`.** `styles` is typed `Record<string, React.CSSProperties>`, so a missing key
is `undefined` rather than a compile error, and **spreading `undefined` into a style object is a silent
no-op.** Two call sites had therefore been styling nothing at all since they were written, and `tsc` and
ESLint were both perfectly happy. The contextual buttons were a plainer miss — they passed `disabled`
and never spread a disabled style at all — **so the bar had three ways of drawing an unavailable control
and only one of them worked.**
An audit across every importer found exactly one phantom key, so the sweep is done — **but nothing stops
the next one, and the failure is invisible by construction.**

### appStyles.ts #299 / #371 — 3px was one pixel too few
`#299` dropped a 44px floor from the corporation strip: **a minimum height on a card whose contents
already exceed it does nothing except on the one screen where the card is nearly empty.**
**#371 — reported:** the train chips inside that card are clipped at the bottom. `#299` was right about
the floor and wrong by a hair about the padding. The chips are 24px, so at 3px top and bottom the card
is 30px — **which fits, until the row WRAPS. A wrapping flex container distributes its lines by
`align-content`, whose initial value is `stretch`**, and any ancestor rounding or a partially-filled
last line pushes the final row against the padding edge. 6px, plus `alignContent: center`.

### appStyles.ts #581 / #599 / #614 — The status-line dock
**#581:** anchored to the bottom **edge** rather than given a height, so the expanded history grows
upward from the line and never off the screen. `maxHeight` with `overflowY` is the ceiling — **a long
history must not become the whole window;** 60vh leaves the board visible above it.
**#599:** the reserved height constant is the **seed only.** The real value is measured from the dock and
applied inline — a constant was right while the dock had one height and became "the log covers the page"
the moment it could grow.
**#614 — the dock must not be the thing that scrolls.** *Reported:* "the only way to collapse it is to
scroll all the way to the top of the log." **The dock is a column whose FIRST child is the header
carrying the Collapse control, so a dock that scrolls can carry its own escape hatch off-screen** — and
with the history list scrolling too, a wheel gesture landed on whichever of two nested scrollers was
under the pointer. **One scroller, and it is the list:** `overflow: hidden` here, `flex` and `minHeight:
0` down the chain, so a capped dock shortens the HISTORY and never the header.

### appStyles.ts #601 / #631 — Two dead fallbacks in one `??`
Eight `rosterPill*` styles were deleted with the unreachable pill branch. `#406`'s 8em name ceiling is
the one constraint worth carrying forward — **`SeatOrderTrail` does not clamp its names, so a table of
long sandbox nicknames widens the trail rather than truncating; if that ever overflows, a max-width on
the seat name is the fix and this is the note that predicted it.**
**#631:** `playerCashBadge` and its parts are deleted too. It was the `seatOrderTrail ?? …` fallback in
the non-Operating-Round branch, and `#601` had already worked out that the trail is non-null for exactly
the two rounds that branch renders — **and the one state that might have slipped past (no `gameState`
yet) fails the cash guard as well, because that figure derives from the same absent state.**
**That is the second dead fallback in this one `??`.** Both were kept "for the case the trail does not
cover", both described an empty set, and both compiled and linted perfectly for months. **The shape to
distrust is a fallback whose condition is the negation of a condition maintained in a different file.**

### appStyles.ts #518 — The sub-phase trail is one object with divisions
Connected boxes rather than separated pills, which is what makes it read as a **sequence** rather than a
set of tags: the segments share edges (`marginLeft: -1px` collapses the doubled border between
neighbours). **The same construction the par ladder on the stock cards uses, and for the same reason —
both describe positions along one track.** `flexWrap` because six steps at the era's full length can
outrun a narrow window, and **a wrapped trail still reads in order where a clipped one loses its tail.**

### appStyles.ts (smaller entries)
- **#481** — the inline sub-phase is sized and coloured as a *continuation* of the round label, not a
  second heading: "OPERATING ROUND · LAY TRACK 2/5" should scan as one line, because it is one fact split
  across two spans only because half of it is conditional. `whiteSpace: nowrap` because the bar wraps,
  **and a step name broken across two lines inside a wrapping row is how a 48px bar becomes a 70px one.**
  `orPanelStepperRow` is gone with the row it framed — **a style kept "in case" is how a deleted row
  comes back.**
- **#426 (button sizing)** — `#31` slimmed the action buttons on the reasoning that a chrome strip needs
  only "comfortably clickable", **which took them below comfortable.** These are the primary actions of a
  turn and several are destructive-ish, so they get one step of the type scale back.
- **#236** — the corporation figures **continue from the left.** `marginLeft: auto` flung them to the far
  edge, so reading "PRR … $640" meant crossing the bar and the figures ended up further from their own
  label than from the window edge. `orContextDot` is gone: **a dot of the corporation's colour drawn on a
  bar of the corporation's colour was invisible by construction.**
- **#575** — the bar's acronym takes `rosterLiveryAcronym`'s typography **exactly**, monospace face and
  tracking included. Approximating it would give the same company two slightly different looks on two
  screens, which is the specific thing the change was asked for to stop.
- **#266** — twenty `route*` keys were deleted here with the panel they dressed; they live in
  `RoutePlannerPanel.tsx`, next to the only markup that ever used them.
- **#490** — the dividend block is a **section** of the panel now, not a card floating beneath it. The
  full border is gone (**a box inside a box reads as a separate object**); what remains is a hairline
  doing the one job the border really did.
- **#214** — the market-move arrow is the one glyph carrying a DIRECTION, so it is the one that takes the
  direction's colour, sized and weighted past the zone-tinted prices either side. `lineHeight: 1` because
  the diagonal glyphs sit taller than the digits.
- **#563 / #317** — the player-card grid is its own section rather than merged into the corporation grid
  (**a shared grid would imply they were comparable cells**), and escrow is muted so it qualifies the
  figure beside it rather than competing with it.

---

## `App.tsx` — the shell's render tree (JSX residue)

Notes that lived in JSX comment containers and were missed by the Batch 1 scan.

### App.tsx #18 (item 4) / #21 — Turn alerts mount off bare `isMyTurn`
The keyframes are injected unconditionally (matching `Chatbox.tsx #2`'s convention for this codebase's
plain-inline-style escape hatch) and the pulsing overlay mounts directly off `isMyTurn` — **no gating
value, because `#21` made both channels mandatory with no opt-out anywhere.** The document-title flash
is the other half and has no DOM footprint at all.

### App.tsx #537c / #578 — The hotseat toolbar was a solo tool, then went entirely
`#537c` hid it in a room, and **both of its controls are the reason.** The seat picker exists so one
person can play everybody, which is precisely what identity gating forbids (`#534` makes the local id
the viewer) — **a seat picker would offer a switch the dispatch gate refuses.** The scenario switcher
re-seeds the board from a fixture, which `#537` had just stopped doing in a room, and **leaving a visible
control that now does nothing is worse than removing it: a player clicks it, nothing changes, and the
natural conclusion is that the game is broken rather than that the control does not apply.**
**#578 deleted the toolbar outright** — seat switcher, auto-follow, scenario picker and train fixture
were all controls for playing four people from one keyboard. The scenario and fixture pickers went with
them rather than being kept: **they seed a board, and a room's board comes from its log.** The phase
switcher that had moved into the toolbar went with it — two places to change sandbox settings is worse
than one.

### App.tsx #32 / #39 — The tutorials mount at shell level, three of them, mutually exclusive
Mounted at the shell rather than inside the phase panels **so a modal survives its panel unmounting on a
tab switch** — one that vanished when you clicked Rail Map would have to be re-triggered to finish
reading.
**#39 — three topics, one per round.** All three mount unconditionally and each decides for itself
whether to open, keyed on its own `active`. **That is safe against two firing at once because
`current_round_type` is a single value — the three flags are mutually exclusive by construction, not by
coordination between them.** Each tracks its own "seen" flag, so a player who read the auction explainer
still gets the Stock Round one.

### App.tsx #543 — A prize is shown to whoever won it
**Reported:** at the end of the auction BOTH players were told they had won the B&O and both could set
its par price.
The prompt fires wherever the winning action is APPLIED, **and in a room every client applies every
action — that is the whole design (`#522`). So the prompt was raised on both screens, correctly, and then
rendered on both because `open` asked only whether a prompt existed, not whose it was.** In solo hotseat
that is right: one person is playing everybody. The identity test is the same branch `#534` uses for the
turn gate — no room, no test.
**It matters more than a label:** the prompt does not merely announce the win, **it SETS THE PAR PRICE**,
and two people answering it is two dispatches of one mandatory choice.

### App.tsx #416 / #440 — The home-station prompt blocks, then gets out of the way
Blocking for the same reason the B&O prompt is: **a floated corporation owes its home station and 1830
has no branch where it declines one.** Mounted at shell level because it can fire while the player is on
any tab.
**#440:** the modal hides itself once the player has accepted and been sent to the map — **a backdrop
over the board they were just asked to click would be the flow blocking its own final step.**
`pendingHomeToken` stays true throughout (the token is still owed until the click lands), **which is what
brings the prompt back if the placement is abandoned.**

### App.tsx #581 — The log is a status line, not a headline
**Reported:** "I don't see the Activity Log ticker at the bottom of my screen?" — expecting a
recommendation made twice and then not built. **It was at the top, in flow, where it has always been.**
**The ticker and the action bar want opposite things from the reader.** The bar is what you MUST DO and
should be the most findable object on screen; the log is what HAS HAPPENED and should be readable without
ever demanding attention. **Stacked at the top they compete**, and the report two passes earlier was that
the action bar was losing — which is why putting the ticker *inside* it (tried, reverted, `#490`) made
things worse.
**A status line at the bottom edge is the arrangement every IDE and most games converge on for exactly
this content: peripheral, always present, never modal.** Unlike a toast it needs no dismissing, which
matters at 1830's event volume — the reporter's own objection to toasts, and a correct one.
**Fixed, so it survives scrolling the board.** The app root carries matching bottom padding so the last
row of content cannot hide underneath, and **the box is anchored at the bottom rather than sized — so the
expanded history grows UPWARD from the line instead of off the screen.**

### App.tsx #419 — A panel inside `isWorkspaceTab` must say which workspace it is for
**Reported:** the Buy Trains from Bank panel bleeds into the Stocks and Stock Market tabs.
It did, **and the gate is why it was easy to miss:** `current_round_type === "OperatingRound" &&
orSubPhase === "Hardware"` is a precise, correct statement about **when** the panel applies and says
nothing about **where.** That branch sits inside `isWorkspaceTab`, true for four tabs — **so during Buy
Trains the panel rendered on all four, including the two whose entire subject is share trading.**
**This is `#27`'s bug again.** That note fixed the auction dashboard hijacking the Rail Map by adding a
tab test to a condition that had only a phase test, and wrote down the lesson. The Stock Round panel
beside this one learned it; the train panels did not. **The offer ledger leaked identically — same phase
gate, same missing tab gate, same four tabs — and is fixed in the same pass, because a fix that left it
bleeding onto the Stock Market tab would have answered the report rather than the bug.**
`surfaceTabFor("OperatingRound")` rather than a literal `"map"`, **so if the Operating Round's home tab
ever moves this follows it instead of quietly pointing at the wrong surface.**

### App.tsx #233 — The offer ledger appears when there is one
This rendered on every Hardware step, empty, reading "No offers outstanding" — **a permanent panel whose
permanent content was that it had nothing to show.** Worse, it sat directly under the purchase panel, so
the first thing a player saw when they went to buy a train was a heading about offers that did not exist.
**A pending offer is an EVENT.** It arrives, blocks a turn, gets answered and goes away — so the panel
representing it should do the same. The gate is scoped to offers **the viewer is party to** rather than
any offer in the room, because this is the surface where they ANSWER one. `TrainTradePanel #1` argued a
pending offer is public information and should be visible to everyone; **that is still true and is what
the Action Log carries. A dedicated panel on the buy screen is a different claim — that you have
something to do here.**

### App.tsx #45 — An allowlist, not a denylist
This read `activeMainTab !== "phase"`, **which silently assumed the only workspace tabs were the phase
surface, the map and the chart.** Adding `"corps"` (`#41`) therefore opted it in by default: the Stocks
tab passed the `!==` test, fell past the `=== "map"` branch, and **rendered a second copy of the Stock
Market matrix underneath the corporation cards.** Naming the two tabs that OWN a board means a future tab
has to ask for one rather than inherit it.

### App.tsx #28 / #41 — The reference tabs
**#28:** the phase tab renders NO reference board. Its content is the phase panel above, and the market
chart has its own tab — **rendering the chart here too is what the old single-tab design did, and it is
precisely the conflation this note split apart.**
**#41:** the roster is gated on the TAB alone, not on the round. It renders during an Operating Round and
the auction too, **because "what do I own and what is it worth" does not stop being a question when the
Stock Round ends.** Its Buy/Sell controls are separately gated, so an out-of-phase viewer reads but
cannot act.

### App.tsx #23 — `!spectator` is load-bearing, not decorative
`TileSelectionPopup` is the **second** of this app's two gameplay dispatch paths — it calls
`execGameplay` itself (that component's `#1`) rather than routing through `runGameplayAction`, **so the
gate inside that function does not cover it. Not mounting it is what covers it.**
The action bar is likewise hidden entirely for spectators: **that is the COURTESY half of read-only mode
— the guarantee is `runGameplayAction`'s gate**, which holds whether or not the bar renders. Hidden rather
than disabled because a row of twenty greyed buttons offers a spectator nothing, and the room strip's
badge already explains why they are gone. The sandbox room strip sits *outside* that branch: **a
spectator has no action bar and the room strip is not an action, so hiding it with the controls would
take away the one thing a watcher might legitimately want.**

### App.tsx #162 — The in-situ radial selector replaces the popup
`TileSelectionPopup` — a ~900px floating card with a carousel, era tabs, a rotation panel and a dispatch
button — is no longer rendered. **It answered "which tiles exist" well and "does this tile fit HERE" not
at all, because judging fit means looking at the hex and its neighbours, and the card covered them.**
The two branches it had (chain-backed and offline) collapse into ONE, and **that merge is safe because
the distinction never lived in the presentation:** it is carried by `provisional`, which labels the ring,
and by `canConfirm`, which decides whether a lay can be dispatched at all. **Keeping two nearly identical
JSX blocks was how the old spectator bug got in — one branch grew a `!spectator` guard the other did not
need, and the asymmetry was invisible.**
**The file is retained, unrendered, until the radial path has been exercised against a live chain** —
deleting a component whose replacement has only been run offline would leave no way back.

### App.tsx (smaller entries)
- **#141** — the refused-click cue is **amber, not red**: nothing failed and the player did nothing
  wrong, they clicked a hex that cannot take a tile. Red is reserved for the query error above, which IS
  a fault. It reuses the same floating indicator the loading/error states use, **so the feedback appears
  in the one place a player is already watching after a hex click.**
- **#34** — one bar. The room context is the middle of the single header now. It still says WHICH room
  this shell is bound to (every query targets `gameId`, and someone with two tabs open needs to tell them
  apart) and **is still the only place `chatError` surfaces, because chat failing silently is worse than
  chat saying it is broken.**
- **#31** — THE one action bar, hoisted above the phase branch so it renders on every active tab. **It
  used to live inside the non-auction branch only, which is why the auction grew its own Pass and the
  phase tab ended up with two bars.**
- **G-15 (train trading)** — safe to gate tightly on the Buy Trains step, and worth spelling out why: **an
  offer can only be CREATED in Hardware, and while one is outstanding the buyer's turn is blocked there**
  (`operations::PendingTrainOfferBlocksTurn`), so an offer cannot outlive the phase that produced it.
  `orSubPhase` tracks the ACTIVE corporation's step, not the viewer's, **so a seller still sees this
  during the buyer's Hardware phase — the only time their answer is wanted.**
- **#205 / #218** — one train-consent prompt, two sources, decided by deployment: sandbox uses local state
  (no chain to record an offer in, no second client to show it to); online derives from the contract's own
  register so the prompt reaches the real counterparty. **Mutually exclusive by construction**, so it can
  never show two offers at once.
- **#165 / #166** — the trade sheet composes an offer, the prompt answers one. Rendered at shell level
  because **both outlive the panel that opened them — the prompt in particular has to survive the
  sub-phase advancing.**
- **#602** — the Stock Round's player cards mount between the corporation cards and the board pane:
  **they are two halves of one screen, and the players belong under the companies they hold.**

## Short notes and cross-references — Batch 5A

### App.tsx #158 — The Tutorials front door is its own state
Separate from the four `TutorialModal`s' own state, **deliberately: those track "has this player been shown
this yet", which is a different question from "is the reader open right now".** Rendered alongside the
auto-opening modals rather than inside the tab bar — **it is a modal over the whole shell, not a part of the
navigation that summons it.**

### App.tsx #427 — The reference tabs get a way back
The return bar's reason is stated beside the button rather than left to the button's wording. Only rendered
while the player is standing somewhere the round is not played (`#390`/`#404`).

### App.tsx #483 — The reachable EDGES, carried alongside the hexes
Reachability is a property of track, not of hexes: a hex can be reached along one edge and not another, so
the reachable set travels as edges and the veil reads them.

### App.tsx #521 / #537b — Sandbox multiplayer, offered rather than demanded
Solo play needs no gesture, so the room strip is an invitation rather than a gate. **`#537b` releases the
roster when a room ends, so a solo session afterwards is not still holding the room's seats.**

### App.tsx #568 / #573a — The auction's own text, and what an exchange closes
`#568`: the auction renders private descriptions from **the same catalog** every other surface uses.
`#573a`: an exchange closes the **COMPANY**, which is why the certificate is deliberately not marked used —
the two are different events and conflating them would double-count the closure.

### App.tsx #598 — The message box, hidden until asked for
The chat input and its filter pills are the two rows `#581`'s one-line status dock gives back; they appear
in the expanded view, **because filtering is something you do while READING the log.**

### App.tsx #250 / #291 — Two `null`-not-zero cases in the Operating Round
`#250` — **no train, no route**: a corporation with an empty fleet reports `null` rather than `0`, because
"cannot run" and "ran for nothing" are different facts and only one of them is a revenue figure.
`#291` — **the dividend decision moves the marker too**, which is why the projection is computed beside the
buttons rather than left to the chart.

### appStyles.ts #40 — The rails must GROW, not merely exist
A grid rail with no width cannot centre anything: `minmax(0, 1fr)` gives the rails a floor of zero **and**
the ability to take width, which is what makes the centre column centre on the panel.

### appStyles.ts #427 / #603 — The return bar, and why a card is a rectangle
`#427`: the reason the return bar is on screen at all is stated beside the button rather than left to the
button's wording.
`#603`: the turn-order bar worked through the same distinction `#631` later applied to the seat card — **a
pill reads as a tag ABOUT something; the thing itself is a rectangle.**

### FinancialLedger.tsx #170 — See `ContextualSubPanel.tsx #170`
A name beats a truncated hash, **and the resolver returns `null` for a real wallet so live rooms are
unchanged.** (`#559` is the room-aware version this file actually imports.)
