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

---

# The ticker and the dock — `components/TopTicker.tsx`

### TopTicker.tsx #1–#7 — Charter
**Presentational only** — every prop is derived or owned by `App.tsx`, the single owner of the chat and
action log. **The unread badge double-guards on `!isExpanded` itself** so it can never flash visible for one
render during a transition. **No border-radius, shadow or backdrop:** this is no longer a floating panel but
an in-place section flowing out of the active nav tab, **so it intentionally has none of the old modal's
chrome.**
**Notification settings are gone entirely (`App.tsx #21`)** — both turn-alert channels are mandatory with no
per-player opt-out, **and the expanded body is JUST the scrollable history.**

### TopTicker.tsx #476 — The whole game, not the last seven lines
**Reported:** the Activity Log truncates and retains only the last handful of entries.
**The STATE was never truncated** — the log has always prepended without a cap. **What threw the history away
was one line:** the expanded panel sliced the last N items before rendering, **so everything older existed in
memory and could not be reached by scrolling because it was never in the DOM to scroll to.**
**That made the scroll container a lie.** It had `overflowY: auto` and a `maxHeight` of exactly seven lines,
**so it looked scrollable and had nothing above the fold — the one arrangement where a scrollbar never appears
and the player concludes the log simply forgets.**
The constant survives as what it always physically was: **the VIEWPORT height, in lines. It sizes the box; it
no longer decides what exists.**
**The cost is bounded in practice** — a full 1830 game is a few hundred short strings. **If a long session ever
makes this heavy the answer is windowing, which needs the full array to window OVER; truncating the source
would remain the wrong fix.**

### TopTicker.tsx #615 — Five rows, now that five rows is not a limit
**Instructed:** "now that the log scrolls, I wonder if it would be okay to trim the expansion to 5 lines?"
**Yes, and the question contains the reason it is safe.** Seven was never chosen as a good reading height —
`#476` found the constant being used to TRUNCATE and left it at seven while converting it into a viewport.
**At the time the number decided what existed, so shrinking it would have thrown entries away. It decides
nothing now.** Five rows is roughly 230px against seven's 320, **which takes the open dock from about half a
laptop viewport to under a third.**
**Not lower than five.** Three or four would fit more comfortably **and would stop the panel being a place you
can read a stretch of the round in — a log you have to scroll every second entry is a log you stop opening.
Five holds a full turn's worth of actions on one screen, which is the unit a player actually wants to read
back.**

### TopTicker.tsx #425 — One string, and no pictures in it
**Reported:** make the expanded history render the full text string, identical to the ticker, and remove every
emoji and graphical badge.
**Two renderers, two different sentences.** The collapsed ticker built its line in one place; the expanded list
built a different one out of separate spans. **They agreed about nothing:** the ticker appended the detail when
short enough and the list dropped it in favour of a hover `title`; the list rendered a category badge the
ticker had never heard of; **both prefixed a status emoji, from the same helper, in different positions.
Expanding the panel to read a line in full showed the reader a line they had not been reading.**
**So the string is built ONCE and both surfaces render exactly it. "Identical to the ticker" is now structural
rather than a thing to keep in step by hand.**
**The emoji are gone, all of them.** They were carrying real information badly: **a green circle means
"succeeded", which in a log of things that have already happened is true of nearly every line, so the column
was a near-constant costing horizontal space in a one-line ticker.** The category badge was worse — **inferred
by substring-matching the label ("tile", "stock", "train"), so it restated a word already visible in the
sentence beside it, and mis-tagged whenever a label happened to contain someone else's keyword.**
**Errors keep their mark, in words.** Dropping the status glyph would have lost the one status that is not the
default. **That is the whole of what the circles were for.**
**The round prefix stays `[OR 1]` and leads the line.** It is the only bracketed element left, **so it reads as
a gutter rather than as one badge among several.**
The detail is carried in **full, not as a 40-character preview** — the truncation existed because the string had
to survive in a single-line ticker, **and the ticker clips with CSS `text-overflow` instead, which shortens the
DISPLAY without shortening the sentence the expanded view then renders in full.** `whiteSpace: normal` on the
expanded line is the other half: **the ticker clips because it has one line, and this wraps because it does
not.**
The four styles those columns used are **deleted rather than left unused — an orphaned badge style is an
invitation to render a badge again, which is the thing this pass was asked to remove.**

### TopTicker.tsx #477 — The time leads
**Reported:** the timestamp sits at the end of the line; the format should be
`[hh:mm] [Phase/Round] [Actor] [Action]`.
**Why the front is right and not merely requested.** The expanded history is now the whole game (`#476`), **so
it is a column of entries a player scrolls to find something in. A column is scanned down its LEFT edge, and
the two facts that locate an entry — when, and in which round — were the two furthest from it:** the round was
second, and the time was past the end of a sentence of variable length, **so it landed in a different column on
every row and could not be scanned at all.**
Leading with both puts a **fixed-width gutter** down the left: `[14:32] [OR 1]` is the same shape on every line.
**hh:mm, not hh:mm:ss** — a full locale time string carries seconds, **three characters of precision nobody
needs about a board game and enough width to unbalance the gutter.** Dropped for DISPLAY only; the epoch
remains the sort key.
**Parsed rather than reformatted from the epoch, deliberately.** The label is already localised — 12-hour with
an am/pm suffix in some locales, 24-hour in others — **and re-deriving it here would impose this module's idea
of a locale on a string the rest of the app formats elsewhere. Trimming what is there keeps one formatter.**
**Any label it cannot parse is passed through whole.** A locale this regex does not anticipate produces a
slightly wider gutter, **which is a cosmetic defect; dropping the time entirely, or emitting `[Invalid Date]`,
would not be.**

### TopTicker.tsx #616 — Unread CHAT MESSAGES, not unread feed items
**Log entries are a record to consult rather than a queue to clear, and counting them gave a badge that read
four digits and meant nothing.** Counted off the **unfiltered** feed by the caller, **so a player filtered to
"log" is still told a message arrived.**

### TopTicker.tsx #458 — The latest line, where the player is looking
**Reported:** the ticker scrolls out of view when scrolling down the page, **so the most recent instruction is
lost exactly when the player is working on the map.**
The ticker sits in the page chrome and scrolls away with it; the action bar directly below is sticky and does
not. **So the fix is not to make a second ticker sticky — it is to put the one line that matters inside the
element that already stays.**
**One line, not the panel:** no expansion, no history, no chat input. **The full ticker is still the place to
read back through what happened; this answers only "what just happened", which is the question a player
scrolling the board has.**
**It shares the formatter, so the sticky copy and the ticker cannot disagree** — `#425` made that one string for
exactly this class of reason, **and this is the third surface to read it.**
**Clickable, because a player who reads a truncated line needs somewhere to go** — it scrolls them back to the
full ticker rather than opening a second copy. **It must never wrap:** the bar has a fixed height band, **and a
two-line log entry would push the controls out of it.** Ellipsis rather than a scrollbar — **the full text is
one click away and a scrolling sliver of text in a toolbar is unreadable.**

### TopTicker.tsx #457 — The log belongs to the chat, not to the tabs
**Reported:** the ticker's background matches the tab bar above it, so it is easy to miss.
**It matched because it was chosen to.** `#20` paired the header with the active tab on the reasoning that both
are chrome. **The consequence is that the one line carrying "what just happened" reads as a continuation of the
navigation — an area the eye has already learned to skip, because nothing in it ever changes.**
**It belongs downward.** Below is `InlineQuickChat`, **and the two are one conversation: the log is what the
game said, the chat is what the players said, and expanding the ticker shows them interleaved in a single
feed.**
**A left accent rather than a brighter fill.** Raising the whole surface would have made the newest game event
the loudest thing on the page, competing with the board. **A 3px rule down the live edge separates it from the
tabs without shouting, and it is the same device the chat entries already use to mark an author.**

### TopTicker.tsx #598 / #600 / #614 — The Chat toggle, and the row that did not know about it
**#598 — the dock is a status line, so it is one line.** *Reported:* "the Chat/Activity log at the bottom needs
to be slimmed down: it's bigger than the traveling Action bar and ostensibly less useful." **Both halves are
true and the second explains the first.** `#581` docked this to the bottom edge precisely BECAUSE it is
peripheral, **and then left it three rows tall. A peripheral surface taller than the primary one is not
peripheral.** The filters go with the input — **filtering is a thing you do while READING the log, so they
belong in the expanded view and are noise on a one-line status strip.** The toggle lives INSIDE the header row,
**because a second row for one button would be the problem again.**
**#600 — the Chat button was sitting on "Expand".** *Reported, and the cause is `#598`'s own fix.* The toggle
HAS to live outside the header element, **because that element is a `<button>` and a button cannot contain a
button.** `#598` solved the nesting by taking it out of flow entirely — **but the expand hint is the last flex
child of that same full-width header, so it renders at the row's right edge too. Two controls, one corner,
neither aware of the other. The overlap was not a near-miss; it was guaranteed by construction.**
**Absolute positioning cannot be undone here** — the nesting rule is real. **What was missing is that nothing in
the flow KNEW about it.** So the row **reserves the space**: an empty, `aria-hidden` flex item of exactly the
toggle's width, with the toggle positioned into it. **`flexShrink: 0` because a slot that can be squeezed is not
a reservation.**
**Which means three numbers must agree, and that is why they are named constants rather than literals at four
call sites:** the toggle's offset is the row's padding, plus the hint's width, plus the flex gap.
**The hint's width is fixed for a second reason.** The label flips between "▼ Expand" and "▲ Collapse", **which
are different widths — so a hint sized by its content would shift the reserved slot every time the panel opened,
dragging the Chat button sideways under the cursor mid-click.**
**A slot also fixes a quieter bug:** the preview text is `flex: 1` and was measuring the full row, **so a long
activity line ellipsised UNDER the Chat button rather than before it.**
**#614 — the header is its own positioning context.** *Reported:* "there is a stray 'Chat' button in the expanded
window". **There was, and it was the same button.** `#598` positioned it against the root — **correct while the
root WAS the header row and nothing else. Expanding the log makes the root the header plus a 300px scrolling
body, and an element centred on that box lands halfway down the history.** So the header and its satellite get
their own relatively-positioned wrapper.
Vertically centred **by transform rather than a magic `top: 3px`, so the control stays centred if the row's
min-height or the toggle's padding ever moves.**

---

# The player cards — `components/PlayerCards.tsx`

### PlayerCards.tsx #563 — A table scans, a card reads
**Instructed:** "while I love the table/spreadsheet in Game Ledger for Player Assets, I wonder if in the Stock
Round it would be better to create tiles/cards like we did for the corporations but for players instead."
**Both, and for a stated reason rather than as a compromise. The two screens ask different questions of the same
data:**

| | |
|---|---|
| **The ledger** | "how does everyone compare" — a **ranking** question, answered by a column of aligned figures you read **down**. A table is the right shape and the existing one stays untouched. |
| **The Stock Round** | "what is this player holding, and what can they afford" — a question about **one person at a time**, answered by a block you read **across**. Their corporations, privates and spending power belong together, **and a table splits them across columns that cannot show a per-corporation breakdown at all.** |

**So the card matches the corporation card deliberately** — same livery stripe, same two-column figure tables,
same private table at the foot. **A Stock Round is a screen of cards, and a player card that looked like a
different kind of object would read as a different kind of thing.**
**#563a — the private table is absent, not empty.** *Instructed explicitly, and worth keeping as a rule:* **an
empty table with headers is a promise of data that is not there, and four of them on one screen is most of the
screen saying nothing. A card with no private section is shorter, which is itself the information.**
**The same is NOT done for the holdings table, and the difference is the point:** every player has cash and
certificates, **so a player with no shares has an empty holdings list which is a real and readable state
("bought nothing yet"). Owning no privates after the auction is equally real, but the auction is over by then
and the table has no further story to tell.**
The Priority Deal lives in the **stripe**, because it is a property of the SEAT rather than of the portfolio —
**it says who opens the next Stock Round, not what this player owns. Everything below the stripe is holdings;
this is not.**

### PlayerCards.tsx #567 — What came off the card, and why
The first pass carried three marks that each looked like information and were not, **and the playtest found all
three:**

- **The heralds.** A corporate logo beside a three-letter ticker **identifies nothing the ticker had not already
  identified, at 14px where the artwork is a smudge.** They earn their place on a corporation CARD, which is
  about one company and has room to be about it.
- **The "YOU" badge.** Every player is reading their own screen; **the card that is theirs is the one they
  already know.** It is worth drawing **only when two players share a display name**, which is the sole case
  where the reader genuinely cannot tell — **so that is exactly when it appears.**
- **"PD".** An abbreviation invented to fit a space that turned out not to be tight. **"Priority Deal" is two
  words and the stripe holds them.**

The crown moved to the **right** of the acronym for the same family of reason: **on the left it pushed every
ticker in the column out of alignment by the width of a glyph most rows do not have, so the one column that
should scan cleanly was ragged in proportion to how many presidencies were on screen.**

### PlayerCards.tsx #593 / #595 / #606 — The cards state the turn order, they do not imply it
**Instructed:** replace the Auction's Seating Order table with these cards — "the tables make it easy to see
turn order, whereas the cards are less direct about that. Is there a solution?"
**There is, and it is not "rely on the order they are laid out in". The grid reflows** — six players wrap on any
window narrower than about 1600px — **and the moment it wraps, left-to-right stops meaning anything and the seat
after the last card on row one is the FIRST card on row two. A reader would have to know the wrap point to read
the order.** So the position is written down.
**Only where seats take turns.** Omitted during an Operating Round, **where the queue names corporations and a
seat ordinal would be answering a question nobody is asking.**
**#606 — the flag's job no longer exists.** The ordinals became "ON TURN" and "ON TURN" became the lift, **so the
last thing that boolean gated is gone. It is not replaced by another flag, because `activeAddress` already
carries the same fact: a round with no seat on turn passes `null`, every card compares unequal, and nothing is
marked. A second prop saying "and mean it this time" was always redundant with that.**

### PlayerCards.tsx #606 — Lifted out of the row, in the seat's own colour
**Instructed:** "rather than an 'on turn' tag, would it make more sense to desaturate the inactive cards and
slightly 'lift'/raise the active one?" — and, on the ring: **"the green border is maybe a little weird because it
doesn't coordinate to the player color or anything else."**
**The green was inherited, not chosen.** It came from the roster pills, **where green was the only colour
available because pills had no seat identity of their own. These cards do:** the stripe two pixels above the ring
is the player's colour, and the action bar's trail lights the acting seat in that same colour. **So the green was
a third colour system on a surface that already had one, asserting "on turn" in a hue that means "positive"
everywhere else and nothing about WHO.**
**The lift is a real lift.** `-2px` was a nudge no reader would name; **the request describes the card-game
gesture, where a chosen card rises clear of the row.** `-10px` against a 10px grid gap clears roughly a card's own
edge.
**The shadow is doing half the work.** A translate alone reads as a card that has drifted; **a translate plus a
deeper, softer shadow reads as one that has been picked up.** The two are one `box-shadow` declaration **and
cannot be split**, so both are cast at the call site with the ring.
**The lift needs somewhere to go.** A card rising 10px out of a row with a 10px gap lands exactly on the edge of
the row above, **and its ring and shadow then overlap the card behind it — which reads as collision rather than
elevation.** `rowGap` only, **not `gap`: the clearance wanted is vertical, and widening the columns to buy it
would push a six-player grid to a second row sooner.** `paddingTop` is the same clearance for the first row,
**which has no row above it to borrow from.**
**The raise only reads as a card being picked up if it takes time.** Snapped instantly it is just a card drawn
10px higher, **which a reader interprets as a layout bug before they interpret it as a state. The movement is the
message.** `transform` and `box-shadow` only, **never `all`** — the stripe's saturation is on a different element
and wants no transition (**a fading colour during a turn handover reads as loading, not as handover**), and `all`
would sweep up every future property anyone adds.
**Reduced motion keeps the answer, loses the movement:** the card still sits raised with its ring and shadow, **it
simply arrives there. Switching motion off must never cost the reader the fact the motion was carrying.**
**#606a — the turn still has to be spoken.** Deleting the "ON TURN" tag deletes it for screen readers too, **and a
lift, a ring and a saturation step are all invisible to one. Colour and elevation are never the sole carrier of a
fact** — the label says it in words and `aria-current` marks it in the one attribute assistive technology already
looks for.
**The idle stripes step back.** *Instructed:* "just to desaturate the color stripes, not to the point that they
can't be distinguished." **Taken literally, and the literal reading is the correct one: this is on the STRIPE, not
on the card.** Everything below the stripe is what a player is comparing across seats while deciding a bid, **and
dimming a rival's balance to advertise that it is not their turn would trade a fact for a decoration.**
**`saturate`, not `opacity`:** opacity would wash the stripe toward the card's cream and pull the label's contrast
down with it; **`saturate` leaves lightness and hue in place, so the black-or-white ink choice stays valid.**
**0.55 is the whole brief.** The seat colours are already mid-saturation, **so this lands them near 25% — muted,
but slate blue, brick, moss, plum, ochre and teal all still read as themselves side by side. It is the one number
to move, and moving it far in either direction breaks a different half of the request.**

### PlayerCards.tsx #583 / #609 / #658 — Two tables that have to agree
**#583:** the gap widened and the columns are no longer equal — **the % column is fixed at three characters, so
the holdings table needs far less width than an even split gives it**, and the reported symptom was the Corp
column sitting "barely separated" from the figures on its left.
**#609 — the holdings column takes what it needs.** *Reported:* "the 'Corp %' column is stretching to take up the
same space as the left column. This is unnecessary." **It was, and `0.85fr` is why — a fractional track claims its
share whether or not it has anything to put there.** Splitting the card 58/42 gave the narrow column room it could
not use and squeezed the wide one. **`auto` sizes to content and hands the remainder to the figures**, per card —
**a player holding one corporation is not held to the width of a player holding five.**
**#609 (spacer row) — instructed:** "can we fix the header line for 'Corp' and '%' at the same row as the 'Cash'
row?" `#583` had put an empty header row here so the two BODIES started level. **That worked, and bought it by
opening the left column with a blank line — so the card's top-left corner, where a reader's eye lands first, was
whitespace.** **There was never a row-for-row correspondence to preserve** — five fixed figures against a
variable-length holdings list — **so aligning the bodies was aligning two things that do not correspond.**
**#658 — a grid item stretches, and a table obeys.** *Reported:* "the two double-column tables 'start' at
different heights … PRR and C&O seem to be widely spaced apart to fill up the size of the table."
**Both halves of that are one line of CSS.** The body is a grid, grid items default to `align-self: stretch`, and
the row is as tall as the FIGURES table. **The holdings table is stretched to match, and an HTML table given more
height than it needs does not sit at the top of it: it distributes the surplus across its own rows.** With a
header and two holdings that is three tall rows with centred text — **so `Corp.` sinks to somewhere between `Cash`
and `Net Worth`, and PRR and C&O drift apart. Nothing was positioning them; they were being inflated.**
`alignItems: "start"` is the whole fix.
**Why `#611` did not catch this:** that note aligned the two tables' **headers**, and **it was right about the
markup** — the figures table has no `<thead>`, so its first row and the holdings header genuinely are both row
one. **The alignment it describes is real and is what the DOM says. It just never survived layout, because the
note was reasoning about row ORDER while the defect was in row HEIGHT. Two elements can be in the same row of the
same grid and still not appear on the same line.**
**One row metric, spread into every cell of both tables.** The two tables aligning **is not a coincidence to be
re-established each time somebody edits one of them — it is the point of the layout, so it is a value rather than
a convention. Six style keys agreeing by hand is exactly the arrangement that drifts:** the holdings header was
missing the 2px the figures rows carried, **and nothing could have reported that.** `verticalAlign: "top"` rides
along because the same intent explains it — **a cell that centres its text re-introduces the reported symptom the
moment any row is taller than its neighbour, and top-aligned cells simply cannot.**
**#568:** the private's NUMBER stays, on instruction — "referring to Private Company 1 is easier than remembering
some of the names". **`#423` removed the numeric chips because a bare `3` names nothing away from the auction's
numbered list; a number IN FRONT OF the name is the opposite trade and costs two characters.**

### PlayerCards.tsx #562 / #562a — An em dash, and the gap that is the point
**#562 — an em dash, never "$0".** A missing figure and a figure that is genuinely zero **are different facts
about a player's position, and only one of them means they are broke.**
**#562a — LIQUIDITY versus NET WORTH: the gap between them is what the card exists to show.** Liquidity is cash
plus **only the shares that could legally be sold right now** — a president's block cannot be sold unless
another player already holds 20%. `sellableHoldings` (`utils/playerFinance.ts`) owns the presidency and
pool-cap rules, **so this only has to add up its answer — and the two surfaces that ask "what can this player
pay with" (the emergency-funding modal and this card) get the same number by construction rather than by
agreement.**

---

# The turn-order trail — `components/SeatOrderTrail.tsx`

### SeatOrderTrail.tsx #595 — An ordinal is not an order
**Reported:** '"1st," "2nd," etc may be confusing if they think the Players cards are referencing final score' —
and, in the same breath, the better idea: **"what if we grab the subphase tracker from the Operating Round and
show P1 > P2 > P3 in the Stock/Auction Action panel?"**
**Both halves are right.** "1st" beside a player's name in a game with a score is genuinely ambiguous — **in 1830
the thing players most want ranked IS net worth, so a card reading "1st Ada $2,400" invites exactly the wrong
reading.** And a grid of pills can only imply sequence through layout, **which stops meaning anything the moment
the grid wraps.**
**A chevron trail says it out loud.** `Ada › Ben › Cai` is not a ranking, **it is a queue: the separator carries
the meaning that position alone could not, and no reader mistakes a chevron for a scoreboard.**
**The same component shape as the Operating Round's step trail, deliberately.** A player has already learned to
read `Track › Tokens › Routes` as "here is the sequence, here is where we are". **Reusing that grammar costs them
nothing to learn, and the two rounds stop having two different ways of answering one question.**
**Not a copy of that component, though.** The stepper knows about eras, private companies and which steps exist
this phase; **none of that is true of seats, and inheriting it to reuse a chevron would drag a rules engine into a
list of names.**

### SeatOrderTrail.tsx #597b → #599 → #603 → #603a — Three passes to stop being five pills
**#597b — the par ladder's shape, not a pill.** *Instructed:* "Rather than each player having a pill, what if we
used the rectangle from the Par selector and instead of / between players we used a >?" **Better than the pills for
a reason the request implies rather than states: the par ladder is a row of INTERCHANGEABLE options of which
exactly one is lit, which is precisely the shape of a turn queue.** A pill is a self-contained badge — **five of
them read as five separate objects that happen to be adjacent, and the rounded ends fight the chevron's attempt to
join them into a sequence.**
Padding is **this file's own, slightly larger than the ladder's:** that value is defended in `StockRoundPanel` by a
specific width budget, **and a name is longer than a par value. Copying the number rather than the intent would
make the ladder's constraint govern a row it knows nothing about.**
**#599 — one rectangle, not five objects.** `#597b` restyled the SEGMENTS and left the container a bare flex row
with a 2px gap — **the half that matters least. A row of transparent segments floating on the bar's own surface has
no edge to belong to, so the eye still groups by the only boundary it can find — the lit fill — and reads five loose
objects.**
**A drawn border is the thing that was missing.** Once the row has one outline **the segments stop being candidates
for grouping: they are subdivisions of a single object, and a subdivision that fills with colour is unmistakably
"the live one". This is why the par ladder works and why copying only its segment padding did not.**
**`gap: 0`. The segments must be FLUSH** — a gap reintroduces the whitespace that made them read as separate chips,
**and it is the one value that cannot be tuned by taste: any non-zero gap undoes the border.**
**#603 — the fill has to reach the edges.** *Reported:* "each player is still given their own pill in the
rectangle." `#599` **stopped one step short AGAIN, for the same reason, one level in.** The container had 2px of
padding and the segments a 4px radius, **so the lit fill floated clear of the rectangle's own edges on all four
sides. A shape that does not touch its container is a shape sitting INSIDE its container, which is the definition of
the pill this was supposed to stop being. Two pixels of padding were doing all the damage.**
No padding, no radius, `alignItems: stretch`. **The lit segment runs border to border — a slice of the object rather
than an object on a tray — and that is what makes the chevrons read as pointing OUT of the filled block.**
**`overflow: hidden` is what lets both be true at once:** the segments stay square **and the first and last are
clipped by the container's own radius. Without it a lit end seat would poke square corners through the rounded
frame.**
**No wrap.** A wrapped row would leave a half-width second line inside the frame, **and the segments-of-one-bar
reading dies the moment the bar has two rows.**
**#603a — the chevron is the point, so it gets to be seen.** *Reported:* it is "both small and indistinct as a
colour". **Both true, and both were deliberate in a way that turned out to be wrong:** `#597b` styled it as
punctuation. **But this glyph is not punctuation here — it is the ONLY thing on the bar that says the row is a
sequence rather than a list. `#595` is explicit that the separator carries the meaning position alone could not, and
then `#597b` styled it like it carried none.**
**So it moves up the scale, not just in colour** — 12px reads as a comma at this weight **no matter what colour it
is.** Still dimmer than the lit segment, **which is the one hierarchy worth keeping.**

### SeatOrderTrail.tsx #639 — Rivals' money here, yours on your card
**Instructed:** "perhaps it makes sense to re-insert inactive player's treasury amounts in that ordering, and leave
the active player's in their player card."
**That is the right split and it resolves what `#637` removed and what `#637` admitted it was losing.** Taking the
figures off entirely was the correct answer to a duplication problem — **but it also took away every OTHER seat's,
which was never duplicated anywhere on the sticky bar. `#342`'s rule survives after all: "in an auction the question
that decides a bid is what can THEY spend."**
**So the figure is suppressed on exactly one segment — the lit one.** The card below states it in full, labelled,
with escrow spelled out; **the trail would be repeating it two inches away in a compressed form that caused the
"+$200 looks like earnings" reading in the first place.**
**It also keeps six seats fitting** — the acting segment is the one that carries a colour fill, **so dropping ~35px
from it is width bought back exactly where the row is busiest.**
**Escrow rides with it and is likewise inactive-only:** it is the number that decides whether a rival can still
raise, **which is the whole reason to look across the row.**

### SeatOrderTrail.tsx #610 — This seat has passed since anyone last acted
**Instructed:** stamp "PASSED" over a player's name, with the worry that **"this might make some new people think
that that player has permanently passed"** — and the answer to it, "if we remove the stamp on the player's next turn
that might mitigate it."
**The mitigation is structural rather than a rule this component enforces:** the passed set derives from
`consecutive_passes`, **which the reducer zeroes the instant anybody buys or sells. So the stamps cannot outlive the
round of passing that produced them, and no timer, no local state and no cleanup pass is involved.**
**What it costs is one reading, and it is worth it.** "PASSED" beside four names is a picture of **how far round the
table the passing has got — which is what the auction header's "3 consecutive pass(es) so far" was trying to say in
prose, against a roster the reader then had to map it onto themselves.**
**The stamp is not a stamp.** The request's word means the rotated, distressed overprint, **which is the right IDEA
and the wrong artefact for a 24px-tall segment read left-to-right at speed: rotated text in a row this dense costs
legibility on the name underneath it, which is the thing being marked.** Small caps, wide tracking, a warning tint,
after a struck-through name — **the same thing at the same glance, in about 34px.**
**Amber, not red.** Passing is an ordinary move in both these rounds — **in the Stock Round it is very often the
correct one — and red would grade it. Amber marks a state without judging it, and stays clear of the green this app
spends on positive figures.**
**Struck through as well as tagged, so the two cues agree:** a strike alone would be ambiguous (**eliminated?
bankrupt?**); the tag alone is four small capitals in a crowded row.
**The names now clip rather than push.** The trail is `nowrap` inside a frame with `overflow: hidden`, **so before
the PASSED tags existed an over-wide row would have silently lost a whole end segment. Truncating a long nickname is
a far better failure than dropping a player off the queue, and the full name is in the `title`.**

### SeatOrderTrail.tsx #597c / #599 (chips) — What the segments do not carry
**Instructed:** "the Action bar player pills do not need 'PD' or '(you)' in them, these are just making the pills
larger." **Both were mine and both were paying for themselves in width on the one row that has least of it.** And
neither was needed: **the player CARD already marks the Priority Deal in its stripe, and a player does not need
telling which seat is theirs on a screen they are looking at** — `#567` reached that same conclusion about the YOU
badge two passes earlier **and I put it back on the trail without noticing.**
`viewerAddress` **stays on the interface, unused by the render, because a caller passing it is stating something
true** — and removing the prop would make re-adding the distinction a plumbing job rather than a styling one.
**The seat's colour DOT is gone (`#599`):** it was doing identity work the fill now does for the one seat that
matters, **and on the four seats it survived on it was a third token in a segment the request asks to hold two.**
The name span carries **no styling of its own** — it exists so the name and the treasury are two flex items on one
baseline. **Deliberately NO `overflow: hidden`: on an inline-level box that moves the baseline to the bottom margin
edge, and the figure beside it would stop lining up.**

---

# The round-detail footer — `components/ContextualSubPanel.tsx`

### ContextualSubPanel.tsx #1–#5 — Charter
Driven **entirely** by `current_round_type` and nothing else. The branch covers all three real variants explicitly
— **rather than letting the Waterfall Auction genesis phase fall through into the Operating Round branch by
accident.** The auction pane is deliberately a **short pointer**, not a duplicate of the dashboard: **without it the
pane would be blank or, worse, silently misrendered as an Operating Round panel.**
**Routes and train sheets are NOT fabricated** — `state.rs` genuinely models hardware ownership and
`pathfinding.rs` genuinely traces routes, **but no `QueryMsg` exposes either** (`gameState.ts #2`). **This panel
says so directly rather than inventing plausible-looking numbers.**
Before a real query resolves it renders **one honest placeholder row instead of an empty or broken-looking table.**

### ContextualSubPanel.tsx #170 — Show the person, not the hash
The President column rendered a raw bech32 address clipped to something like `juno1san…0000`. **In the sandbox
every seat's address shares a prefix and a run of zeroes, so all four players truncated to a near-identical string
and the column became four rows of visually indistinguishable noise. A player could not tell which corporation was
theirs from the one panel whose job is to say so.**
The label resolver **returns `null` for anything it does not recognise — which is exactly the right shape here: a
live room's real wallet falls through to truncation unchanged, so this improves the sandbox without inventing a name
for a stranger.**

### ContextualSubPanel.tsx #10 — What this table can and cannot source
Five of seven columns are straight `GameStateResponse` fields. **The other two behave differently:**

- **Market value is not on `GameStateResponse` at all.** It lives in `GetMarketGrid`, which is why it arrives as a
  separate prop — **and without it the column reads "--" rather than substituting par value, which is a different
  number and would be silently wrong for every floated company.**
- **The price-change arrow is observed, not reported.** Nothing says "a dividend just resolved", **so this compares
  the price against the last one seen.** Inside an Operating Round that inference is sound: **the only thing that
  moves a price during an OR is the dividend decision.** Share sales also move prices, **but those happen in Stock
  Rounds, so the ref is cleared whenever the round changes — an arrow never carries over from one round into the
  next.**
- **Routes / last run cannot be sourced at all.** The pathfinder really does compute revenue during an Operating
  Round, **but no query returns it and there is no field to reconstruct it from.** The column renders "--" with a
  plain-language tooltip — **included rather than omitted because the layout was specified with it, and a visibly
  empty column is a more honest placeholder than a quietly missing one. The dash means "not reported", not "did not
  run".**

### ContextualSubPanel.tsx #449 — Operating order, and unfloated dimmed
**Reported:** sort strictly by operating order, and grey out unfloated corporations.
The table rendered in `company_id` order — **the contract's table order — while the round it describes runs in a
completely different one. A player reading down this list to work out who acts next was reading the wrong sequence,
and nothing on screen said so.**
**The same rule the operating-order builder uses:** market price descending, then par, then id. **Reproduced rather
than imported because that function returns only the FLOATED queue, and this table shows every corporation including
the ones that cannot operate — so the two answer different questions over the same comparison. The comparison is the
part that must not drift, and it is three lines.**
**Unfloated sort last and dim.** A corporation with no price **is not somewhere in the middle of the operating
order, it is absent from it**, so it belongs after the queue rather than interleaved by whatever par it happens to
carry. **Dimming is the second half of the same statement: the row is context, not a participant.** The UNFLOATED
badge stays — **the dimming says "not in this round", the badge says which rule.**
The privates a corporation's **treasury** owns are listed here too: **they pay it every Operating Round and carry
the powers it may exercise on its turn, so this table — the one a player reads while deciding what to do on that
turn — was the place they were missing from.**

### ContextualSubPanel.tsx #645 — Both sides of "of" are round numbers
**Reported:** '"OR1.1 of 1," which should probably be "OR 1.1 of 1.1," and later "OR 3.1 of 3.2".'
**The old string put two different numbering systems either side of one word.** `1.1` is a round **name** — cycle
and index, the notation the bar, the log and every 1830 discussion use — **and the bare `1` after "of" was a COUNT
of rounds in the cycle. Both are correct and the sentence is not: "1.1 of 1" reads as a position outside its own
range, which is why it looks broken even though the arithmetic is right.**
**Naming the last round fixes it.** The reader compares two labels of the same kind rather than translating between
them, **and the phase rule — one Operating Round in Phase 2, two in Green, three in Brown — becomes legible from the
number rather than needing to be known.**
**The space after "OR" is the same correction one level down.** The bar writes "Operating Round 3.2" and the label
helper writes "OR 3.2"; **this alone wrote "OR3.2", so a player matching a log line against this panel was comparing
two spellings of one round.**
**No guard on the length.** It is stamped when the cycle opens (`#511`) and the helper floors it at 1, **and if there
were such a state the honest thing is to show it rather than hide it behind a fallback.**

### ContextualSubPanel.tsx #11 / #8 / #572 — Table mechanics
**#11 — corporation leads.** The previous order put President first, on the reasoning that an Operating Round is
about whose turn it is — **but the row IS a corporation, and a table whose first column is not its subject reads as
sorted by the wrong thing. The active row is marked directly, which answers "whose turn" without spending the lead
column on it.**
**One header treatment for every column.** Previously `th` was 600 and mixed-case while the numeric variants only
overrode alignment, **so a seven-column row had headers of two different weights depending on which cell you looked
at. All four variants now differ ONLY in alignment and the divider, which is the whole point of having variants.**
**#8 — the alignment-only overrides carry no padding, border or font, so they must be spread OVER `th`/`td` rather
than used in place of them.** Used bare, **a cell silently loses its box and the row's borders break where that
column sits. The `*B` variants are complete styles precisely because that trap kept catching this table.**
Dividers on `borderRight` rather than `borderLeft` **so the LAST column can use the undivided variant and not draw
an edge against the panel wall. Seven columns is past the point where a row can be tracked by alignment alone.**
**#572 — the footer's own table renders NOTHING now.** The player cards on the same tab answer what it was there to
answer, **and two tables of one dataset make the reader prove they agree. Deleted rather than left returning `null`
— a component that renders nothing is an invitation to find a use for it.**
The Priority Deal marker is **bare text in the same cell as the boxed ACTIVE badge, and that adjacency is exactly why
it must NOT be boxed: two pills side by side read as a pair of equal states, when one is "acting now" and the other
is "acts first next round".** Kept **byte-identical** to the ledger's, **so the same indicator looks the same in both
places.**
**The unfloated badge key was REFERENCED and never DEFINED**, so it evaluated to `undefined` and the badge rendered
as unstyled body text — **indistinguishable from the corporation's name beside it. Nothing caught it because
`styles` is typed `Record<string, React.CSSProperties>`, an index signature that accepts any key and so cannot tell
a real style from a typo.** Colours come from `palette.ts` **so the ledger's copy of this badge and this one
physically cannot drift apart again.** *(Same class as `appStyles.ts #619`.)*

---

# Batch 5C — The tab strip, the chrome, the style scale

## MainTabBar.tsx — the tab set is computed

### MainTabBar.tsx #0 — Five declarations, one concept
The `MainTab` union, `orderedMainTabs`, `isTabAvailable`, `surfaceTabFor` and the strip itself all live in one
file **because the tab set is COMPUTED rather than fixed, and a computed set is only coherent if the rule and the
renderer cannot drift apart.** `AppShell` imports only `MainTab`, `isTabAvailable` and `surfaceTabFor`; the
ordering function and the hover CSS stay private.

### MainTabBar.tsx #1 — The active phase leads
**A player's attention starts at the left edge**, and in a game where the legal action changes completely between
rounds the first tab must be the one they can act in — **otherwise every phase transition begins with a hunt.**

### MainTabBar.tsx #213 — One answer to "which tab is this round played on"
**REPORTED:** leaving the auction for a Stock Round dumped the player on the Rail Map instead of the Stock &
Auction surface.

**Two effects disagreeing, and the loser winning.** The transition effect correctly sent a new Stock Round to
`"corps"`. The availability guard declared right below it — which exists because the tab SET changes shape by
phase, so the active tab can cease to exist under the player — **ran in the same commit still reading
`activeMainTab` as `"phase"` (React has not re-rendered, so the first effect's write is not visible yet)**, found
`"phase"` absent from a Stock Round's tab list, and redirected to a hardcoded `"map"`. Declared second, landed
second, Rail Map won every time.

**Reordering the effects would "fix" it by luck.** The real defect is that the guard had its own opinion about
where to land and that opinion was a constant. Both callers now ask one function.

**The mapping** (`#28`'s split, stated once): the auction has a dedicated phase surface; a Stock Round's surface
IS the Stocks roster (`#41` — there is no `"phase"` entry that round); an Operating Round is played on the rail map.

### MainTabBar.tsx #390 — The tabs that are not a place to act
**REPORTED:** players get confused viewing the map during a Stock Round, or the market during an Operating Round.

**The naive check `activeTab !== surfaceTabFor(roundType)` is wrong for three of the six tabs.** `ledger` and
`rules` are REFERENCE surfaces — opened mid-turn precisely to check something before acting — and `stock` is the
market chart, read during every round. **Treating those as "the wrong tab" would replace the action panel with a
redirect the moment a player consulted anything, which is a worse trap than the one being fixed: it makes the
reference material cost you your controls.**

So the redirect fires **only when the player is on ANOTHER ROUND'S PLAYING SURFACE** — the map during a Stock
Round, the corporations during an Operating Round.

### MainTabBar.tsx #404 — Reference tabs get the bar too
**REVERSES #390, which is left standing rather than edited away.** #390's reasoning was sound and its conclusion
wrong, **because it assumed the alternative was leaving the FULL action bar there — and the full bar is the actual
hazard.** Playtest: Pass and Undo sit live on a screen the player is only reading, and **a turn gets spent by
accident from the Game Ledger. A misclick on a reference tab should not be able to end a turn.**

So the exclusion goes and the panel on those tabs carries **the Return button and NOTHING ELSE** (panel half in
`ContextualActionBar.tsx`). `isPlayingSurface` is kept and still exported — the distinction is real and the bar's
copy differs for the two cases — **but it no longer gates the redirect.**

### MainTabBar.tsx #46 — Hover states need real CSS
Only the states inline styles cannot reach live in the `<style>` tag; **resting and active looks stay in
`styles.mainTabButton`/`mainTabButtonActive`, so there is one place to read a tab's normal appearance rather than
two that have to be kept in agreement.** Inline `React.CSSProperties` cannot express `:hover` (`Lobby.tsx #3`), and
**an unselected tab that never responds to the pointer is the specific thing that made these read as disabled.**
`:focus-visible` mirrors hover **because the browser default outline is nearly invisible against this dark chrome.**

### MainTabBar.tsx #158 — The Tutorials front door is not a fifth tab
Pinned right past an auto margin and deliberately NOT styled as a tab: **it does not change which screen you are
on, it opens a reader over whichever screen you are already on.** Tab treatment would imply a navigation it does
not perform and put a permanently-unselected tab next to four that highlight.

---

## TopBar.tsx — one slim strip

### TopBar.tsx #0 — A pure move
The component body, its three private helpers (`firstMissingEnvVar`, `nativeBalanceTitle`, `statusDotColor`) and
`NETA_CREDIT_CSS` are the same text `App.tsx` carried. **Each helper has exactly one caller. As top-level functions
in a 9,600-line file they looked like shared utilities and meant reading `TopBar` required scrolling away from it.**

### TopBar.tsx #28 — Phase tab vs reference boards
`"phase"` splits a conflation present since the tabs were flattened: one tab was both "the thing you act in" and
"the stock market chart", renaming itself between Auction / Stock Round / Stock Market. **That made the 2D market
chart — a REFERENCE board a player wants mid-auction to see where prices stand — unreachable during the two phases
where it is most worth consulting, because the tab that would have shown it was busy being the auction.**

| Class | Tab | Meaning |
|---|---|---|
| ACTIONABLE | `"phase"` | the surface where the current round is played (auction dashboard, or Stock Round panel) |
| REFERENCE | `"map"` | rail map (**also actionable in an OR**) |
| | `"stock"` | market chart — always just a board |
| | `"ledger"` / `"rules"` | never actionable |

**The Operating Round has no dedicated `"phase"` surface** because its actionable surface IS the rail map, so
during an OR the phase tab is absent and `"map"` leads. **That is why `orderedMainTabs` returns a LIST rather than
a fixed array with a reshuffle: the tab set itself changes shape by phase, not just its order.**

### TopBar.tsx #41 — `"corps"`, the persistent Stocks tab
The roster used to be reachable only as the Stock Round's phase surface, **making "who owns what, and what is it
worth" a fact you could look up during a Stock Round and nowhere else — including during the Operating Round that
decides those valuations.**

**NAMING TRAP:** the id is `"corps"` with LABEL "Stocks"; a DIFFERENT tab has id `"stock"` with label "Stock
Market". **`"stock"`/`"stocks"` as sibling ids would be one letter apart and impossible to review; the two surfaces
are unrelated (a corporation roster vs. the price chart).**

### TopBar.tsx #34 — One top bar
There were **two full-width headers stacked above the tab bar** — this one and a room strip — **three rows of
chrome before a single hex of the board, and not even different subjects: both are "what am I connected to".**

Now one slim strip: identity and room context left, connection controls right, `Connect Keplr` last. Room content
arrives as a `roomContext` NODE rather than being rebuilt here, **because the sandbox phase switcher and the
spectator badge need state that lives in `AppShell`.**

**Deleted, and why it was safe:**

- **The cash readout** — in-game cash belongs to the Game Ledger and Player Index, not the row that also shows a
  crypto balance. **That adjacency was the exact F-3 confusion, and the honest fix is not two visual treatments of
  two kinds of money side by side, it is not putting them side by side.**
- **The field labels** ("Master Wallet", "Session Key", "Wallet") — a truncated bech32 next to a status dot needs
  no caption; tooltips carry the full values.
- **The always-visible "Initialize Session Key" button** — now appears only while actionable (wallet connected,
  session not ready), then collapses to a dot. **A button that has been pressed and cannot usefully be pressed
  again is just width.**

The session key is **condensed, not dropped**: it authorises gameplay transactions, so its state stays visible and
its error still renders inline.

### TopBar.tsx #40 — The phase badge is not in this bar
It was, briefly, between the brand and the room context. **Wrong slot for a measurable reason: this header is a
single `flex` row, and two more pills pushed the wallet cluster onto a second line, undoing #34's consolidation.**
The badge lives at the far right of the Contextual Action Bar, **which is also the better home on the merits — the
bar already says WHAT ROUND it is; the phase says which trains and tiles that round can use.**

### TopBar.tsx F-4 — Why the wallet cannot connect
`config.ts` deliberately no longer throws at import (`config.ts #0`) — **an unconfigured build boots into offline
mode instead of dying. The cost of that correctness is that "Connect Keplr" would otherwise look like it should
work and simply fail on click.** Surfacing the reason names the exact environment variable. **Computed at render,
not memoised: it reads build-time constants that cannot change during a session.**

### TopBar.tsx #47 — The Neta DAO credit
Sits with the BRAND, not the wallet cluster: **it is an attribution, so it belongs next to the thing being
attributed — and the right-hand group is the one that already wraps first when the bar gets tight (#34). Parking a
decorative link there would push a functional control onto a second line.** `flexShrink: 0` + `nowrap`;
`rel="noopener noreferrer"` **because `target="_blank"` without it hands the new tab a `window.opener` handle back
into this app.**

---

## TutorialModal.tsx — explain consequences, not controls

### TutorialModal.tsx #0 — What this must not become
The waterfall auction is **the one phase whose mechanics cannot be inferred by looking at it**: a player sees six
cards and a Buy button and still has no idea what happens when the cheapest is bought, **because the cascade is a
consequence, not a control.**

**The rule this file holds itself to: EXPLAIN CONSEQUENCES, NOT CONTROLS.** A modal that says "click Buy to buy" is
**worse than nothing — it trains players to dismiss tutorials unread, which then costs them the one that mattered.**

### TutorialModal.tsx #1 — The preference is global and persistent
"Turn tutorials off" is a **GLOBAL switch, not a per-tutorial "don't show this one again"**: someone who does not
want to be taught the auction does not want to be taught the stock round either. Persists in `localStorage`, not
`sessionStorage` — **a tutorial that returns every time the tab is reopened has not really been dismissed.**
Storage access is wrapped **because private browsing throws on access; the preference then simply does not persist.**

**SEEN-TRACKING IS SEPARATE FROM THE OFF SWITCH.** A tutorial shows once per player per topic even with tutorials
ON, **because re-showing the auction explainer at the start of every auction is exactly the behaviour that makes
people turn tutorials off in the first place.**

### TutorialModal.tsx #412 — Tutorial mode is opt-in, and nothing else is
**REPORTED:** clicking End Turn in an Operating Round yanks the player to the Stock Market tab.

The redirect is `#44`'s and its reasoning is sound **for the player it was written about** — a first-time president
watches their share price move left and reads it as their own mistake. **What it lacked was a way to say "I am not
that player": its three guards are all about the SITUATION, and every experienced player passes through that
situation exactly once per game while wanting none of it.** "They can dismiss the modal" is not an answer —
**the navigation happens before the modal is on screen, and dismissing it does not put the board back.**

**THE POLARITY IS DELIBERATE.** A THIRD flag rather than a reuse of `tutorialsDisabled`, and **the difference is
the default**: the off switch defaults to false, so `!tutorialsDisabled()` is TRUE for everyone who never touched
the setting — **which would leave the redirect firing for exactly the standard play the requirement disables it
for, while looking as though it had been gated.** Tutorial mode defaults to FALSE.

**Only the NAVIGATION is gated.** The explainer still arms and opens under its own rules; it is a panel over the
current screen and costs one click.

### TutorialModal.tsx #159 — Forgetting is not the same as being told to stop
**REPORTED:** tutorials do not appear on the zero-state sandbox, which is precisely where they should.

The trigger was never broken — **what stops it is the SEEN flag, which persists in `localStorage` and which anyone
who has run this sandbox once has already set. The zero state resets the game and had no way to reset the teaching.**

**This deliberately does NOT clear the global off switch:**

| Flag | Records | Reset by |
|---|---|---|
| SEEN | "I have read this one" — a fact about progress through a game | starting a new game (invalidates it exactly as it invalidates the board) |
| OFF switch | "Stop showing me these" — a standing preference about the APPLICATION | the player, only |

**Clearing both would mean a player who ticked "turn tutorials off" gets them back every fresh sandbox, which is
the behaviour that checkbox exists to prevent.**

### TutorialModal.tsx #158 — The tutorials had no front door
Every tutorial opens exactly once, automatically, on its phase becoming active. **A good default and a terrible
only option: dismiss the Operating Round explainer while you think you have understood it, discover ten minutes
later that you have not, and the content exists and is unreachable.**

`TUTORIAL_LIBRARY` is the same four page sets addressed **by name instead of by phase**, and deliberately does NOT
consult the seen flags or the off switch — **those exist to stop tutorials INTERRUPTING, and a player who clicked
"Tutorials" is not being interrupted, they are asking.** `TutorialLibrary` renders the SAME shell via
`TutorialPager`, **so a tutorial read from here is not a second, subtly different presentation of the same words**;
no seen flag is written and no off-switch checkbox is offered. `pageIndex` moved into the pager, **so keeping the
dots/Back/Next shell inline would have meant two independently-maintained readers for one set of words.**

### TutorialModal.tsx #4 — Page shell
The Operating Round pages are several times longer than the auction's. **A fixed height would clip them;
`maxHeight` plus scroll keeps the modal a consistent size on short pages and readable on long ones, instead of the
card resizing under the player's cursor every time they press Next.** Bodies may carry **hard line breaks** — the
OR pages are numbered step lists, and collapsing them into one run-on paragraph would undo the only structure they
have. **Split into real blocks rather than `white-space: pre-line`, so blank lines cannot open ragged vertical gaps.**

### TutorialModal.tsx #44 (referenced) — The Stock Market explainer
Shown on a **FORCED navigation** to the market chart the moment a president finishes their first Operating Round.
**Page 2 is written in the second person about something that has just happened, which is the whole reason this
tutorial interrupts rather than waiting to be found: a first-time president watching their share price drop with no
explanation reasonably concludes they played badly.**

---

## PresidentCrown.tsx #552 — Our own crown, drawn not typed

**REPORTED:** the word "PRESIDENT" takes up a lot of space and long names run into the next column. Bring the crown
back — **but not as an emoji, since those look different on every device.**

**Both halves are right, and they were previously traded against each other rather than solved:**

- **#15** wanted a compact mark, **because the president tag sits inside a right-aligned numeric column and a wide
  one pushes the digits out of alignment.**
- **#490** removed the emoji because "a pictogram that renders in a platform colour font at a platform weight is
  decoration rather than a third channel" — **U+1F451 is a different picture on Windows, macOS, Android and Linux,
  so it could not be relied on to MEAN anything.**

**An inline SVG answers both:** same drawing on every device because we ship the drawing; inherits `currentColor`
so it takes the row's own ink; **roughly one character wide instead of nine.**

**STILL NOT A COLOUR-ONLY CUE** — the constraint #490 was actually defending. The crown is a **SHAPE**,
distinguishable with no colour vision at all, and carries a real accessible name. **Colour, shape and
text-alternative — three channels, none load-bearing alone.**

**SIZED IN `em`, NOT PIXELS**: it sits beside text in five different type scales, and an absolute size would be
right in one of them. **THE GEOMETRY is deliberately coarse** — three peaks on a plinth, rendering at ~11-13px,
**where a fourth peak or a row of jewels closes up into a grey smear.** One filled path, **so it stays solid at
small sizes rather than relying on a stroke width that would round to nothing.**

---

## CorporateLogo.tsx — three asset traps in one component

### CorporateLogo.tsx #410 — The historical logo, with the ticker behind it
**ONE COMPONENT, TWO SURFACES** — the livery stripe and the Operating Round corporation card — **so a corporation
cannot be a logo on one screen and an acronym on the other** (same reasoning as `#408`'s palette mirrors).

**THE DIRECTORY IS `Logos`, NOT `logos`.** The requirement specified lowercase; the files are `public/Logos/`.
**It matters in exactly one place and it is the place that is hard to test for: the dev server runs on a
case-INSENSITIVE filesystem where both paths work. Most production static hosts are case-SENSITIVE, where the
lowercase path is a 404 against a directory that plainly exists** — so the failure would never appear in
development and **every logo would silently degrade to the text fallback in production, which, because the fallback
is graceful, would look like a feature that was never built rather than one that broke.**

**THE FILES ARE WEBP, NOT SVG.** Every one carries the `RIFF....WEBP` magic number and not one contains an `<svg>`
element — **raster images given a vector extension.** A static host maps `.svg` to `Content-Type: image/svg+xml`;
**a browser handed that type parses the body as XML rather than sniffing it; WebP bytes are not XML, so the decode
fails and `onError` fires** — again producing exactly the pre-feature appearance, on every host, forever. Files
renamed to `.webp` (bytes untouched). **Confirmed by the harness, which reads the magic number of each file rather
than trusting its name — the check that would have caught this in the first place.**

**THE AMPERSAND.** `B&O` and `C&O` carry one. **In a URL path segment `&` is a legal sub-delimiter, so a browser
would usually fetch it unescaped — but it is the query-string separator, and any proxy, CDN rewrite rule or logging
layer between the app and the file is entitled to treat it as one.** `encodeURIComponent` encodes **the FILENAME
only, not the directory separator**, which is why the base path is concatenated rather than run through the same
call. The URL builder is **pure and exported so the encoding can be tested without a DOM — a regression here is
invisible on a case-insensitive dev machine.**

### CorporateLogo.tsx #429 — A circle needs a tighter cap than a stripe
The default width cap is `size * 2.4`, chosen for the livery STRIPE. **The market chart's occupant tokens are
CIRCLES: a herald at 2.4x the circle's height would run out of both sides, and the badge's `overflow: hidden` would
crop the mark rather than fit it — worse than the text fallback, because a cropped herald looks like a rendering
fault while an acronym looks like a decision.** Cap is overridable in pixels; `undefined` keeps the existing ratio,
**so this is a pure addition.**

**The `failed` flag resets per ticker.** A different corporation is a different file, and **a file that has not
been tried yet has not failed. Without this, one missing logo would poison the slot for every corporation rendered
through the same element afterwards — React reuses the component instance when only the props change.**

**Capped rather than fixed square**: these are historical heralds with wildly different aspect ratios (the NYC oval
vs. the PRR keystone), **so a square box would letterbox some and crop none, while an uncapped width lets the
widest one shove the float badge off the end of the stripe.**

---

## ReturnToTurnBar.tsx #427 — A way back from the reference tabs

**REPORTED:** add an action bar to the Ledger and Rules tabs containing only a "Return to [relevant tab]" button,
during a player's active turn.

Every other tab renders `ContextualActionBar` at the top, **so on these two the bar simply vanished — and with it
the only persistent thing on screen that said a turn was in progress.** The failure is small and repeated: a player
checks the Ledger, gets absorbed, **and has to remember both that they were mid-turn and which tab they came from.
The tab bar can take them back, but it does not tell them they need to go.**

**WHY IT IS NOT `ContextualActionBar`.** Every control on that bar acts on the ACTING corporation or seat.
**Those actions belong to the surface where their consequences are visible: skipping the Track step from inside the
Rules tab dispatches a real message and shows the player a rulebook.**

**ONLY DURING THE PLAYER'S TURN** — the restriction is what stops this becoming chrome. **A bar that rendered
always would be a permanent banner that means nothing, which is how persistent UI stops being read at all.**

**THE DESTINATION IS DERIVED, NOT NAMED.** `surfaceTabFor` is the same lookup the round transitions use, so "the
relevant tab" **cannot drift from where the game actually sends a player when the round changes.**

---

## styles/ — the CSS escape hatch and the scales

### animations.ts #0 — Why keyframe strings are a module
Inline `React.CSSProperties` **cannot express `:hover` or `@keyframes`** (`#46`), so the few effects that need real
CSS are template strings injected next to the element that uses them. Grouped **because they are the same KIND of
thing — raw CSS text, not a style object.** `NETA_CREDIT_CSS` and `MAIN_TAB_HOVER_CSS` travel with their own
components instead: **each has exactly one consumer and would only be indirection here.** The turn-alert pulse's
other half — `document.title` flashing — lives in `utils/turnAlert.ts`, **which has no DOM footprint to inject.**

### animations.ts #35 — White, not red
**Two red pulses on screen simultaneously read as one effect, which is worst exactly when both are firing: your
turn, during a contested mini-auction.** The turn indicator moved because **it is the one drawn over EVERYTHING** —
dark chrome, linen-white cards and the map canvas in turn — **and white/crisp silver is the only ink that keeps a
consistent weight across all three; red read as urgent on the dark shell and as a smudge over the cards.** Red is
now exclusively the auction's "contested" colour.

### animations.ts (phase-shift CRITICAL step)
**Opacity rather than the box-shadow glow** the other two pulses use: **this badge sits inline in a crowded action
bar, where a spreading glow would bleed over the controls either side of it; the turn overlay and the auction card
own their whitespace and can afford one.** The pulse **bottoms out at 0.55, not 0 — a warning that blinks fully out
is unreadable for half its cycle, and this one carries text the player needs to read.** Reduced motion drops the
animation and **keeps the static crimson: escalation must survive the animation being switched off, which is the
other reason the two steps differ in colour and not merely in whether they pulse.**

### animations.ts #601 — The mini-auction chaser is gone
`ROSTER_CONTEST_CHASE_CSS` dressed the action bar's roster pills, **which turned out to be unreachable**
(`ContextualActionBar.tsx #601`). Deleting the pills left it with no consumer.

**WHAT IT MEANT IS WORTH KEEPING FINDABLE.** `#545` chose a multicolour chaser for a running mini-auction
**because green is reserved for "on turn in the ordinary rotation", and a mini-auction SUSPENDS that rotation — so
painting a contestant green would assert the one thing that is not true.** The chaser still rings the contested
card in `WaterfallAuctionDashboard.tsx` (`#320`/`#344`). **The bar no longer marks a contest at all;
`SeatOrderTrail` draws the seat queue and says nothing about mini-auction membership.**

### animations.ts #597 — A transition is noticed; a state is not
**REPORTED:** the acting seat's colour "is still too subtle... a very slim border on the left edge".

**TWO SEPARATE PROBLEMS, and the report names both without separating them.**

- **THE BAND IS TOO SMALL.** A 6px vertical sliver on the left edge is **the least visible place a colour can be
  put on a wide panel.** It becomes a full-width bar along the top edge — the widest dimension the panel has.
- **THE CUE NEVER CHANGES.** `#570` made the colour a STATE, and **a state, however bold, stops being seen within a
  few minutes. Habituation is not a matter of contrast; it is a matter of nothing happening. The existing my-turn
  pulse has the same flaw: it is a CONTINUOUS animation, running when you look away and still running when you look
  back, and carries no arrival.**

**SO THE SIGNAL IS THE CHANGE ITSELF.** A one-shot sweep runs whenever the acting seat changes, and stops. **Motion
that starts is caught peripherally in a way that motion which has always been running is not — and because it ends,
it costs nothing for the rest of the turn.**

**TWO INTENSITIES**, because "somebody's turn began" and "YOUR turn began" are different news.

**REPLAYED BY REMOUNTING, not by a timer.** The band carries `key={acting seat}`, **so React replaces the element
on every change and the browser starts the animation fresh. A JS-driven restart would need a class toggle, a reflow
read and a cleanup, all to reproduce what a changed key does for free.** Reduced motion keeps the band, drops the
sweep — **the colour still says whose turn it is, which is the information.**

### corporationLivery.ts #428 — One palette, imported three times
The eight canonical corporation colours and the contrast maths. **The table lived in three files at once:**
`hexContractTypes.ts` (`STATION_TICKER_COLORS`), `StockMarketRenderer.tsx` and `StockRoundPanel.tsx` (two
module-local `TICKER_COLORS`).

**The duplication was deliberate and documented rather than accidental**, which is what made it worth removing
carefully. `#408` ended: "ALL THREE MIRRORS ARE UPDATED TOGETHER ... so changing one would give the map and the
cards different opinions about who a corporation is." **That is a correctness requirement enforced by a comment,
and the failure it guards against is silent: a pass recolouring two of the three would leave the map and the stock
cards disagreeing, with no type error and nothing visibly wrong on whichever screen the author was looking at.**

`StockRoundPanel`'s `#389` already CLAIMED this arrangement — "one table, not a second palette that looks close."
**It was the intent all along; the livery stripe simply read the panel's own private copy rather than the map's.**

**WHY `styles/` AND NOT `components/`:** three consumers in two folders plus `utils/` contrast code. Leaving the
canonical table in `hexContractTypes.ts` **would keep every other consumer importing a corporation's identity out
of the HEX MAP's contract-shape module** — the dependency direction `appStyles.ts` records its own hoist for.
`styles/` imports nothing from `components/`, **so nothing here can create a cycle.**

**THE CONTRAST HELPERS COME TOO, AND THAT IS NOT SCOPE CREEP.** `relativeLuminance` / `bestContrastTextColor` lived
in `hexContractTypes.ts` only by accident of history. **A colour table whose contrast function lives in a different
module is a table that can be recoloured without its legibility guarantee being re-checked** — the specific thing
`#408` audited by hand. Both are **re-exported from `hexContractTypes.ts`, so this is a pure addition** for the
existing call sites.

### corporationLivery.ts #408 — The colours the board uses
**REPORTED:** the corporate colours do not match the physical board game.

The palette **was never canonical — eight plausible, well-spaced hues tuned for legibility without asking what
colour the pieces actually are. For a player who knows 1830 that is worse than an arbitrary palette: the Erie is
yellow on the board, and reaching for the yellow token to find it is the B&O costs more than having no expectation
at all.**

Re-checked rather than assumed against the specified hues:

- **CONTRAST.** Every entry clears **4.5:1** against whichever of black or white `bestContrastTextColor` returns —
  **the WCAG threshold for NORMAL text, which is the right bar because the stripe's ticker is 16px bold and 16px
  bold is NOT "large text" by WCAG (that starts at 18.66px bold).** Lowest is **B&M green at 5.35:1**. The shade of
  each hue was chosen to clear the bar **rather than the bar being lowered to fit a shade.**
- **SEPARATION.** Minimum pairwise **dE across all 28 combinations is 44.4** (ERIE yellow vs. NNH orange), against
  the **8.4** that started `#403`. **Canonical and distinguishable turned out not to be in tension — the physical
  game already had to solve this problem with ink on cardboard.**
- **THE CONTRAST INK FLIPS WHERE IT SHOULD.** C&O cyan, ERIE yellow and NNH orange take BLACK; the other five take
  white. **Asserted per colour rather than trusted.**

**NYC IS `#1a1a1a`, NOT `#000000`.** The requirement allows "a very dark gray to ensure UI legibility": **pure
black would be indistinguishable from the card borders and the chart's gridlines, and a corporation whose livery is
the same colour as the furniture reads as a rendering failure rather than as the New York Central.**

**THE "ALL THREE MIRRORS" PARAGRAPH IS GONE, because there are no longer three mirrors.** Leaving it would tell a
future reader to go and find two copies that do not exist.

Keyed by `public_company::CORE_PUBLIC_COMPANIES`'s fixed `company_id`s (1-8: PRR/NYC/CPR/B&O/C&O/ERIE/NNH/B&M).
**Purely a frontend legibility aid, not backend data.**

`tickerColor` is **THE ONLY WAY TO READ THE TABLE**, exported alongside the record **so callers do not each
re-implement the `?? fallback` — three of them previously did.**

### corporationLivery.ts #46 — The contrast maths
`relativeLuminance` is the standard sRGB-to-linear WCAG formula; `bestContrastTextColor` returns whichever of pure
white or pure black has the higher ratio per `(lighter + 0.05) / (darker + 0.05)`. **Picked dynamically per badge
rather than one colour asserted for every fill: three of the eight are light enough to need black and five need
white, so any fixed choice is wrong for at least three of them.** The old caveat about several colours failing 7:1
AAA **was written against the PRE-#408 palette and is no longer the live situation. AAA is still not claimed.**

### palette.ts — the paper-card treatment
The two card sets were restyled light in separate passes and **drifted immediately: five near-white values, no two
the same, across two components one tab apart — which reads exactly as it sounds: slightly grubby, as though some
cards were dirtier than others.** **The fix is not "pick a better hex twice". It is ONE value both files import, so
a future pass physically cannot restyle one set without the other. Uniformity is now structural rather than a
coincidence that survives until the next edit.**

**THE ONE RULE FOR VARIANTS:** card STATE is expressed through **borders, accents and badges — never through the
card's background.** That constraint keeps the set looking like one deck of certificates instead of a colour-coded
chart. **The single deliberate exception is `CARD_SURFACE_MUTED`**, for a genuinely inert card (an unfloated
corporation with nothing to act on) — a cooler, dimmer paper reads as "not in play" **without introducing a hue.**

`CARD_SURFACE` is a **warm near-white rather than pure `#ffffff`: at full white the cards glare against this app's
very dark chrome, and the gold and green accents both look washed out.**

`CARD_GLOW_MINI_AUCTION` (red `#ef4444`) was **DELETED** by `WaterfallAuctionDashboard.tsx #320`. **Removed rather
than left exported-and-unused: a colour token that nothing imports is a standing invitation to reintroduce the
exact problem #320 fixed.** The chaser's palette is deliberately not a token — **a nine-stop gradient that only
makes sense as a whole, living in the keyframes beside the rule that uses it.**

**The lowest-offered private is GREEN, deliberately outside the gold family.** Gold marks "look here", red marks
"contested", **green marks the third thing — AVAILABILITY, the action you can actually take right now. Three
states, three hues, no overlap.**

**The active-turn pulse is exported as BOTH a hex and a bare `r, g, b` triple**, because the pulse is an
`@keyframes` block built as a raw CSS string and **every stop needs its own alpha. Without the triple the animation
would hardcode `255, 255, 255` and this constant would be decorative — a colour "constant" that the actual colour
does not come from is worse than no constant.**

**TEXT ON PAPER:** every value is dark-on-light. **Light-on-light is the obvious mistake when a surface flips and
is easy to catch; the subtle one is a mid-grey that was fine at 4.5:1 on a dark card and drops to 2:1 on white.**

**WHY "UNFLOATED" IS SLATE AND NOT AMBER.** The Ledger renders two amber pills within a few hundred pixels: the
roster's UNFLOATED badge and the Bank Depot's CURRENT badge. **Two golds that close do not read as two states —
they read as one style applied inconsistently, and the eye tries to relate them. They are not related at all.**
Amber in this app means "look here"; **UNFLOATED is the opposite claim.** Slate says "inert" **without spending the
attention colour, which frees amber to mean one thing again.** **THE SHAPE DIFFERS TOO** — squared 4px and
monospaced where every neighbour is a 999px pill in the body face — **because a distinction that survives being
desaturated is a stronger one, and it keeps working for a red-green colourblind viewer who cannot use the
amber/slate difference at all.**

**ESCALATION COLOURS:** `gamePhase.ts #5` establishes that the phase shift and the rust are THE SAME PURCHASE,
counted by one number. **Two purchases out is orange, one is crimson. Because both readouts read the same countdown
AND the same two constants, they cannot drift into disagreeing about urgency any more than they can disagree about
the count.** **Orange rather than yellow** for the two-away step, **specifically because yellow/amber is already
spent on "look here" and on the Yellow ERA — a yellow rust warning during the Yellow era would be invisible.**

### typography.ts — one tunable scale
The legibility pass had to change ~60 `fontSize` literals across five components. **Doing that by hand is a
one-time fix for a recurring question — the next "still a bit small" runs the same sweep again, and the sizes drift
apart a little more each pass because no two sweeps hit exactly the same set.** The scale is deliberately **SMALL
(seven steps): a scale with a step for every size anyone ever wanted is just the scattered literals again with
extra indirection.**

**WHY NOT A ROOT `font-size` AND `rem`** — worth writing down so nobody tries it and quietly gets nothing:

- **Every style here is an inline `React.CSSProperties` object with explicit `px`. A root font-size does not touch
  a `px` value**, so the change would have had no visible effect without converting all sixty literals anyway.
- **Form controls (`<input>`, `<select>`, `<button>`) do not inherit font-size from an ancestor by default** —
  browsers apply their own UA stylesheet. **Any approach relying on inheritance silently misses exactly the
  controls this pass most needed to fix.**

The canvas renderers are **deliberately OUT of scope**: both have zoom-aware font scaling, **and a fixed scale
imposed from outside would fight those systems rather than help.**

### typography.ts #3 — The third pass, and why it goes the other way
**REPORTED:** the interface has to be viewed at 50% browser zoom to look proportionate on a 1080p screen.

Two passes had run before, **both upward**: ~1.25x over the original sizes, then a further +2px on every step. Net,
body 13→18px, controls 14→19px, badges 10-11→15px, brand title 26→34px. **Compounded, about 1.4x — and a UI drawn
1.4x too large is one a player fixes with the zoom control, which is exactly what happened.**

**THE PREVIOUS FEEDBACK WAS PROBABLY MEASURING THE SAME PROBLEM FROM THE OTHER SIDE.** "Hard to read" and "needs
50% zoom" are not opposite complaints **if the reader was already zoomed out to fit the board on screen: shrinking
the page to see the map makes the text small, the fix applied was to grow the text, and growing the text made the
page need more shrinking. Each pass made the next one necessary.**

So this pass sets **desktop-dense targets AND caps the board to the viewport** (`HexGridRenderer #30`) — **the half
that was missing. Text at a normal size only stays readable if the page is not being zoomed out to accommodate
something else.** Numbers: **13px body, 14px controls, 11-12px badges/metadata, 16px section headings.** Every step
moves together — **bumping only the sizes someone complained about is what produces a scale whose steps no longer
mean anything.**

**Control padding moves WITH the font, always.** The inverse of the note above: **text shrunk without shrinking the
box around it leaves controls that are small AND still tall, which is the worst of both — the density never arrives
and the type just looks lost.** A 14px label in 7px vertical padding is a ~30px control, **which is what puts an
action strip inside the 44-52px band the layout targets.**

---

## utils/stickyCollapse.ts #480 — "Scrolled at all" is not "pinned"

**REPORTED:** the Action Panel collapses the moment the page scrolls off the absolute top. It should stay expanded
until its own top edge reaches the top of the screen.

The old test was `window.scrollY > 24`, **measuring not "is the panel pinned" but "has the page moved". Those
coincide only if the panel is the first thing on the page, which it is not** — a room strip, a tab rail and a
header sit above it. **So the panel collapsed while still sitting in the middle of the viewport with its full
height available, which is the one moment collapsing buys nothing. It threw away rows of content to reclaim space
that was not under pressure, and it did it 24 pixels into a wheel gesture.**

**A sticky element is PINNED exactly when its top edge has reached its sticky offset.** So the measurement is
`getBoundingClientRect().top - stickyTop`, **not a scroll position. It is self-correcting: whatever sits above can
change height, the header can wrap, a banner can appear, and the number still means the same thing.**

**WHY NOT AN INTERSECTION OBSERVER SENTINEL** — the canonical trick, and the first thing tried. **It needs a
zero-height marker rendered immediately above the sticky node, and this panel's parent is a flex column, where a
"zero-height" child is not free: it collects the container's `gap` and pushes everything below it down by that
gap. The cure would have been a negative margin to cancel a height that only exists to be observed** — more layout
risk than the scroll read it replaces. **Measuring the panel itself adds no DOM at all.**

### stickyCollapse.ts #480a — The release needs slack, the collapse does not
Collapsing shortens the panel, which shortens the document. **Near the bottom of a page the browser then CLAMPS the
scroll position — and a clamp moves the panel's top edge back down, below the line that triggered the collapse,
which expands it, which lengthens the document, which lets the scroll return. That is a loop, and it presents as
the bar flickering at the end of a long page.**

**The asymmetric threshold breaks it.** Collapsing triggers **exactly at the pin line**, so the behaviour is
precisely what was asked for; **releasing requires the top edge to be a few pixels clear**, so a sub-pixel clamp
cannot re-cross the boundary on its own. `stickyOffsetOf` **reads the offset from the node's own computed style
rather than assuming it**: `actionBar` uses `top: 0` today, and **a panel that later pins below a fixed header
would otherwise collapse a header's height too early — the same class of error #480 is about.** `auto` and any
unparseable value mean "not offset", **which for a sticky element is 0.**

---

## utils/turnAlert.ts — the tab-title flash

Split into its own hook rather than inlined in `App.tsx` **since it is a self-contained side effect with its own
cleanup/restore responsibility** — the "one clear job per hook" convention `useGameStatePolling` established.

**EXACT ALTERNATION CONTRACT.** While `isMyTurn` is true, `document.title` alternates every 1000ms between the
alert and normal titles, **starting on the ALERT title immediately (not waiting a full second) so a player who
glances at a background tab sees the alert state right away.** The moment `isMyTurn` goes false the interval is
cleared **AND the title is explicitly restored in that same cleanup — so the tab title can never get stuck
mid-flash on the alert string after a turn ends.**

**NO DEPENDENCY ON WHICH TAB IS FOCUSED.** The title updates unconditionally, **matching a real "flash the browser
tab" notification — most browsers only show the alternating title while the tab is unfocused, which is exactly the
situation this feature exists for.**

**The two title constants are the app's REAL title at runtime and they outrank `public/index.html`.** The hook runs
on every mount and assigns unconditionally, **so whatever `index.html` sets is only ever visible for the instant
before React mounts. Renaming the app means renaming BOTH, and missing this one would have left the old name
flashing back into the tab a moment after load — which is worse than not renaming at all, because it looks like a
bug rather than an oversight.**

The hook takes an **already-computed `isMyTurn` boolean** and has no wallet or game-state knowledge of its own,
**matching this codebase's "presentational/effect hooks don't own address-resolution logic" split.**

---

## utils/playerLabels.ts — what to call a player

### playerLabels.ts #559 — Two functions with one name
**REPORTED:** in the Ledger's Corporation Assets panel the presidents are listed as `p-6aq2qcgg` rather than the
names they set in the lobby.

**There were two `sandboxPlayerLabel`s.** `App.tsx` declared a room-aware one at module scope; `utils/sandboxState.ts`
exports the fixture's Alice/Bob table **under the same name.** Every surface `App.tsx` rendered got real names;
the two components that imported the label directly — `FinancialLedger` and `ContextualSubPanel` — **got the
fixture version, which has never heard of a room and correctly returns `null` for a `p-` id.** The caller then fell
back to `truncateAddress`.

**THE IMPORT LOOKED RIGHT, which is the whole difficulty.** Nothing about `import { sandboxPlayerLabel } from
"../utils/sandboxState"` suggests it resolves a different set of names from the identically-named function two
files away, **and the failure is silent and partial: most of the app shows names, one panel shows ids, and the
panel that shows ids looks like it has a formatting bug rather than the wrong data source.**

One registry, one resolver. **Being the file that happens to own the room does not entitle `App.tsx` to a private
copy.**

### playerLabels.ts #535b — Module scope, so no hook depends on it
The first cut was a `useCallback` inside `AppShell`, **and the linter immediately named the cost: twelve hooks read
it, so it became a dependency of all twelve.** A stable `[]` callback **would still have meant editing a dozen
dependency arrays — churn in exactly the hooks (the dispatch, the auto-skip, the forced withhold) where an
accidental rebuild re-arms an effect that dispatches.**

**A module-level map avoids the question rather than answering it.** Its lifetime is the tab — the same lifetime as
the player id it keys on (`#528`) and as the room — **and `AppShell` remounts on any game change, so there is no
stale-between-games case.**

### playerLabels.ts #537b / #578 — No mock names in a real room
`#535` made this a fallthrough (room roster first, fixture second) so solo sandbox kept Alice and Bob. **Right for
the solo case and wrong for a room: if a real id ever failed to resolve, it would fall through and be labelled with
SOMEBODY ELSE'S NAME. A player mislabelled as "Alice" is far worse than one labelled with a raw id, because it
looks correct — and it would be a name belonging to a person who is not in the game, on a screen whose whole job is
to say who is.**

So **once a room has dealt, the fixture table is unreachable**: an unknown id returns `null` and callers fall
through to `truncateAddress`, **which is ugly and unmistakably NOT a claim about identity. Ugly and honest beats
tidy and wrong on a roster.**

**#578:** there is no solo sandbox now, so the fixture branch is reachable **only in the moments before a room's
`SetupGame` replays.** KEPT, not deleted — **the fixture still seeds the BOARD a room boots from, so a corporation
could momentarily carry a fixture president, and returning that name would be worse than returning nothing.**

### playerLabels.ts #569 — A seat colour that does a job
**ASKED:** "Do the player tiles/cards work better with colors? ... The colors don't get used elsewhere as far as I
can remember."

**That last clause is the whole argument, and it points at a fix rather than at a removal. Colour that appears in
exactly one place is decoration and the player is right to be suspicious of it. Colour that means the same thing in
several places is a language.**

**SO IT GETS A SECOND JOB**, and the job was already asking for it: the action bar is easy to see during an
Operating Round **because it wears the acting CORPORATION's livery, and hard to see during the Auction and Stock
Rounds because those rounds have no corporation to borrow from. They have an acting PLAYER.**

**NOT THE CORPORATION LIVERIES**, on instruction: **a player stripe in the PRR's red would read as a claim about
the PRR, and on a screen where corporations and players sit side by side that ambiguity is expensive.** Chosen well
away from the eight corporate hues and from each other.

**CHOSEN OR ASSIGNED.** A seat that has picked a colour keeps it; a seat that has not gets the next by index.
**Both paths are here rather than the picker owning the fallback, so a player who never opens the control is never
colourless and two players can never end up with one colour.** Index rather than a hash of the address,
deliberately — **a hash gives two seats the same colour roughly a third of the time at six players, and "roughly"
is not a property a table of six people can live with.**

---

## Small shell modules

### index.tsx — the React 18 entry point
Uses `react-dom/client`'s `createRoot` (the concurrent-root API), **not the legacy `ReactDOM.render`, which is
deprecated under React 18 and prints a console warning.** **ASSUMPTION (unverified in that pass):** expects an
`index.html` with `<div id="root">`; **no `public/` folder was present alongside `src/` when this was written**, so
`ROOT_ELEMENT_ID` is the single line to follow a different scaffold. Wrapped in `React.StrictMode` — **no effect on
production builds.**

### utils/address.ts — `truncateAddress`, moved unchanged
It has **two callers — `TopBar` and `AppShell` — which is precisely why it could not travel with either. A helper
shared by two components that is declared inside one of them makes the other import from a sibling for a four-line
string function.**

**NOTE THE NAME COLLISION, pre-existing and deliberate:** `utils/lobby.ts` exports its own `truncateAddress`, and
`App.tsx` carried a comment explaining it was NOT importing that one **because this local version takes
configurable lead/trail lengths.** That comment travelled to the import site in `AppShell`. **Two truncators is
still one too many; unifying them is a separate tidy-up.**

### utils/buildStamp.ts #640 — Which build is the browser actually running
**Three round-trips of one debugging session went to the question "is the build you are looking at current". Each
time the answer had to be inferred from incidental evidence** — whether the phase badge read "Phase: 3 (Green)" or
"Phase: Green (3-Train)", whether the depot showed one train or six — **which works, is slow, and only works for
whoever remembers what changed when.**

**A REPORTED BUG THAT CANNOT BE REPRODUCED HAS EXACTLY TWO EXPLANATIONS, and they need completely different work:
the code is wrong in a way the tests miss, or the running bundle predates the fix. Telling them apart first costs
one number; guessing wrong costs a pass of investigation aimed at code that is already correct.**

**A HAND-BUMPED CONSTANT, deliberately, rather than a git hash or a compile-time timestamp:**

- **A hash needs build plumbing (`REACT_APP_*`, a CI step) and answers "which commit" — true, and not the question.
  The question is "does this bundle contain the change we just discussed", which is a human-scale fact.**
- **A timestamp answers "when was this compiled", which a stale dev server will happily report as five seconds ago
  while serving a cached chunk.**

The number is **the highest design note in the source**. Every substantive change writes one, **so bumping this is
the same gesture as documenting the change, and a reader comparing "the fix is #621" against "your build says 612"
needs no other context.**

**IT WILL GO STALE IF SOMEBODY FORGETS** — a real weakness, stated plainly rather than pretending the constant is
authoritative. **A build reporting 640 definitely contains #640, but a build reporting 640 might also contain later
work by an author who did not bump it. It fails in the safe direction — understating, never overstating.**
