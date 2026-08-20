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
