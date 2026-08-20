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
