# Visual-flourish backlog — the living ledger

**Purpose.** The durable record for the visual-polish sequence: what each flourish batch shipped, what it
deliberately left undecided, and every question that can only be answered by watching the game rather than by
reading the code. Companion to `RULES_HARDENING_BACKLOG.md`, which owns correctness; this file owns
presentation. Opened 2026-09-15 with the stock-transaction batch.

**Standing rule: every flourish batch updates this ledger before it is committed.** Add what it left open;
mark closed items `RESOLVED` with the batch and design note that closed them — never delete them. The batch
write-up may summarise; this file is the record.

**Status vocabulary.** `PLAYTEST` — implemented and correct as specified, but the judgement is visual and
nobody has watched it yet. `OPEN` — a known presentation defect or gap. `OWNER DECISION` — a deliberate
choice recorded so it is never mistaken for an oversight. `RESOLVED` — closed; the entry says by what.
`NOT STARTED` — scoped but not begun.

**Gate.** Visual playtest of anything below happens **after rules hardening**
(`RULES_HARDENING_BACKLOG.md` Part F). A flourish judged against a board that is still changing is judged
twice.

---

## Part A — Standing constraints

Every future flourish batch inherits these. They are not preferences; each was established by a report and
each is enforced by a test that fails if it is broken.

**A-1. Screen-space flight across the application shell is reserved for DOLLAR transactions.**

A non-money flourish may move and scale the actual element it is about using transforms when all of the
following remain true:

- the element stays in its existing DOM/rendering subtree;
- it remains inside the existing `uiScale`-zoomed coordinate system;
- its normal grid/flex/layout slot remains reserved;
- no `document.body` portal is created;
- `position: fixed` is not used to escape the element's hierarchy;
- no cross-shell flight layer or shared flourish registry is introduced;
- no second/duplicated rendering of the card is created.

Dividend and Treasury animations retain sole ownership of actual slide-out movement across the application
shell between unrelated surfaces, such as corporation card → player panel.

This exception permits a local element to carry itself farther within its existing subtree/coordinate system
for a ceremonial state transition. It does NOT grant non-money effects the Treasury's cross-shell transaction
vocabulary.

*Revised 2026-09-20 for VF-3 (Approach C).* Originally read "no screen-space flight, no `document.body`
portal, no `position: fixed`", established by the scrapping of #1450. That wording banned the letter of
#1450's mistake — leaving the zoomed subtree — rather than its cause, and would have blocked a corporation
card enlarging and translating toward the Stock Round's own centre while never leaving its own DOM node, its
own subtree, or its own `uiScale` coordinate system: none of what #1450 was actually scrapped for. The
constraint the rule exists to enforce (no portal, no `document.body` escape, no manual zoom-conversion
arithmetic, no second animation registry, no duplicated card) is unchanged and is restated above as the seven
conditions; only the phrase "screen-space flight" is narrowed to mean leaving the subtree, not moving inside
it. Enforced in `stockCardFocus.test.tsx` (VF-1: `document.body` gains no child) and
`corporationCardFloatFocus.test.tsx` (VF-3: same assertion, plus the geometry-failure fallback).

**A-2. An animation must CAUSE the visible final state, not explain it afterwards.**
The affected surface renders a staged snapshot from `before` and advances it to `after` through the procedural
beats. A figure is never final before the gesture that produces it, and nothing changes ungestured.
Established by #1452. Enforced in `stockCardFocus.test.tsx`.

**A-3. Presentation is never required for correctness.**
Authoritative state commits immediately and independently; nothing awaits an animation; every measurement
failure degrades to plain authoritative rendering. Established by #1451.

**A-4. Presentation never re-derives a rule.**
A flourish reads the completed action and the states around it. It does not recompute who should preside, what
something costs, or whether anything was legal. Established by #1451; enforced as an absence test.

---

## Part B — Batches

| Batch | Scope | Status |
|---|---|---|
| VF-1 | Stock transactions / presidency flourish | **IMPLEMENTATION COMPLETE — awaiting visual playtest after rules hardening** |
| VF-2 | Route-running animation | **IMPLEMENTATION COMPLETE — awaiting visual playtest after rules hardening** |
| VF-3 | Corporation float sequence | **IMPLEMENTATION COMPLETE — awaiting visual playtest after rules hardening** |
| VF-4 | Phase transitions — mechanical phase badge flip | **IMPLEMENTATION COMPLETE — awaiting visual playtest after rules hardening** |
| VF-5 | Tile-lay animation | **IMPLEMENTATION COMPLETE — awaiting visual playtest after rules hardening** |
| VF-6 | Bank-break presentation — railroad-ticket endgame countdown | **IMPLEMENTATION COMPLETE — awaiting visual playtest after rules hardening** |
| VF-7 | Rust — corrode / fracture / remove train chips | **IMPLEMENTATION COMPLETE — awaiting audiovisual playtest after rules hardening** |
| VF-8 | Train-limit discard — clean cut / transfer to Bank Pool | **IMPLEMENTATION COMPLETE — awaiting audiovisual playtest after rules hardening** |
| WM | Warning-mark pass — static semantic identifiers (not a flourish) | **IMPLEMENTATION COMPLETE — awaiting visual playtest** |
| AW | Audio wiring — Bank Break, Rust, Train-Limit cues (not a flourish) | **IMPLEMENTATION COMPLETE — awaiting audiovisual playtest** |

### VF-1 — Stock transactions / presidency flourish

**IMPLEMENTATION COMPLETE, awaiting visual playtest after rules hardening.**
Design notes #1451–#1457. Files: `utils/stockTransaction.ts`, `components/stockTransferFocus.ts`,
`components/StockRoundPanel.tsx`, `App.tsx`. Tests: `utils/stockTransaction.test.ts`,
`components/stockTransferFocus.test.ts`, `components/stockCardFocus.test.tsx` (89 cases).

Shipped, all frozen:

- card-local transaction focus;
- participant dimming;
- staged `before` → `after` ownership;
- temporary first-purchase receiving rows;
- ordinary share transfer animation;
- buy/sell-specific presidency procedure;
- 20% president-certificate exchange;
- crown removal / draw;
- row reordering;
- first-president special handling;
- supersession safety;
- presidency SFX.

**VF-3 cross-reference.** The first-president handling (#1453/#1455) deliberately plays only the *destination*
half of the presidency language — no outgoing-president stage, because there is none. The corporation-float
flourish covers the same moment from the corporation's side; the two will need to be watched together so they
do not both narrate the par purchase.

### VF-2 — Train Route Pulse / Revenue Badge Animation

**FINAL IMPLEMENTATION — revenue-reaction design locked, awaiting live playtest.** A different class of
flourish from VF-1/VF-3/VF-5: continuous, board-renderer-driven, and running for as long as Run Routes is on
screen, rather than a one-shot ceremonial transition. Files: `components/routeSignalGeometry.ts` (pure
geometry and timing, no canvas/React/game-rules dependency — the travel/arrival math plus `badgePopScale`,
the scale-only impact curve), `components/TileGraphics.ts` (`railTruncatedAtMarker` exported, purely
additive), `components/hexCanvasPrimitives.ts` (`RouteOverlay.revenueStops`, `drawBadgeShape`,
`drawValueBadge`/`drawValueBadgeAt` scale the printed badge about its own centre via an optional
`BadgeHitVisual { scale }`, new `drawRouteSignalBand`), `components/HexGridRenderer.tsx` (the animation clock,
the rebuild-gated track/assignment cache, the per-hex badge-hit-reaction lookup wired into all eight existing
badge call sites, and the `paintBadge`/`activeBadgeRedraws` late-draw pass that lets an actively-popping badge
clear nearby station-token artwork — see the finalize-pass note below), `styles/routeLivery.ts`
(`ROUTE_TRAIN_COLORS`/`routeTrainColor`, unchanged; the retired badge-tint constants are gone — see REMOVED
DESIGN), `App.tsx` (`revenueStops` populated on both the local and rival route-overlay objects from
`sandboxRouteBreakdown`'s own `.stops`). Tests: `components/routeSignalGeometry.test.ts` (pure unit coverage of
`mostRecentArrivalMs`, `selectBadgeHitReaction`, and `badgePopScale`'s attack/overshoot/settle curve, plus
`matchRevenueStopsToPath` and a real-board-fixture smoke test of `buildRouteSignalTrack`/`pointOnRouteTrack`
against G5→F6→G7, reusing `perCityRevenue.test.ts`'s own $30-at-F6 fixture),
`components/badgeHitPresentation.test.ts` (source-scan coverage of the drawing/ordering contract: centre-pivot
scaling, the late-draw pass, reduced-motion suppression, and that no colour path survives).

**2026-09-21 — two redesigns of the revenue reaction, same day, before the first live playtest.** The original
spec (design notes 7–13) gave every revenue badge a PERSISTENT route-coloured border, divided into per-train
perimeter shares. Wiring that into an actual palette surfaced a genuine conflict: `ROUTE_TRAIN_COLORS` is
deliberately LIGHT (it has to read on a thin dark rail line), and a light colour does NOT read as a badge
border on a white interior. Rather than solve that with a second, paired dark palette (drafted and rejected),
the owner's decision was that the persistent border was never earning its keep — the route highlight already
tells the player which track/revenue centres are contributing — so the badge was redesigned to react only
transiently. The FIRST such redesign made a hit revenue badge's interior briefly flush toward a pale tint of
the arriving route's own colour, fading back to white. A side-by-side visual-prototype comparison
(`Claude outputs/vf2_badge_reaction_comparison.html`) run against real cramped-tile fixtures resolved this in
favour of a SECOND, purely mechanical design instead: the badge's interior never takes a colour input at all,
at any point — it stays plain white/black always — and instead the whole printed badge (fill, border and
number, as one object) physically POPS at the instant of revenue arrival: a fast overshoot past its resting
size, a brief undershoot below it, and a settle back to rest, exactly like a mechanical counter ticking over.
This is the design that shipped, and it is now FINAL. The current design:

- **PRIMARY INFORMATION** stays exactly what it always was — the existing, unchanged coloured route
  highlights (`ROUTE_TRAIN_COLORS`, `routeLivery.ts`). Neither redesign touched this.
- **MOTION** stays exactly what it always was too — the traveling signal loops along each route,
  independently, at the same shared speed, sampled from the same re-parsed authored track data. Untouched:
  signal geometry, speed, length calculations, looping, arrival geometry, route-edit/supersession behaviour,
  the 120ms coincidence-grouping window.
- **REVENUE REACTION** is a scale-only mechanical pop. At rest a revenue badge is the ordinary board badge:
  white interior, plain black border, black revenue number — for EVERY badge, always, whether or not a route
  currently earns it, and pixel-equivalent to the pre-VF-2 badge (`badgePopScale` returns exactly `1`, which
  skips the scale transform entirely). When the travelling signal reaches a matched revenue centre, that
  badge scales up about its own centre to 111% of rest by 60ms, undershoots to 98.5% by 130ms, and settles
  back to exactly 100% by 260ms (smoothstep-eased attack and recovery) — fill, border and text scale together
  as one printed object, so the revenue number stays centred throughout. Two or more arrivals landing on the
  same rendered badge within `BADGE_HIT_COINCIDENCE_WINDOW_MS` (120ms, unchanged) collapse into ONE reaction —
  never two stacked pops, never distinguished by colour — using the same curve shape but a stronger peak
  (117% at 60ms, 97.5% undershoot at 130ms, settling by 260ms exactly as the solo case does), so a coincidence
  reads as one bigger hit rather than two. This is judged on each arrival's own real-elapsed-time timestamp
  against the route-signal geometry (`mostRecentArrivalMs`), never on animation-frame timing, so it is correct
  across loop wrap-around and independent of which train index produced which arrival — a route hitting the
  same badge twice is handled by the identical rule as two different routes hitting it once each.
- **DRAW ORDER.** Station tokens draw after revenue badges in the normal pass, so an enlarged badge mid-pop
  can have its corner painted over by a nearby token. Rather than reorder the whole render pipeline (this
  codebase treats "tokens drawn last" as close to inviolable — see the design note above
  `drawStationTokenPass`), an actively-reacting badge instead defers its own draw into `activeBadgeRedraws`
  (via a small `paintBadge` gate at every one of the eight badge call sites) and is flushed once, immediately
  after `drawStationTokenPass()` runs. A resting badge (the overwhelming majority of frames) is unaffected —
  it still draws exactly where it always did, in the normal pass, with no elevation and no z-order rewrite.
  One narrow, deliberately-accepted exception: the single tile-lay reveal-crossing frame where a hex's own
  printValue is mid-way through its west/east clip split keeps its old (non-elevated) draw order, since
  deferring only one half of that split risks drawing the badge twice at two different alphas.
- **REMOVED DESIGN**, explicitly superseded rather than silently dropped: the persistent route-coloured
  revenue-badge border and its per-train perimeter segmentation (`BadgeRouteBorder`/`allocateBadgePerimeter`,
  removed); the dark hairline keyline that existed only to keep that border legible (removed); a four-colour
  dark badge-border palette investigated as the fix for that contrast problem (drafted, never wired in); a
  paired light-route/dark-badge livery architecture considered as the general form of that fix (never drafted
  past the concept stage); and — as of this finalize pass — the interior colour-flush reaction itself
  (`BadgeHitVisual { color, whiteMix }`, `brightenTowardWhite` as a badge call, `BADGE_HIT_MAX_TINT_SOLO`,
  `BADGE_HIT_MAX_TINT_COINCIDENCE`, `BADGE_HIT_NEUTRAL_COLOR` — all removed from `routeLivery.ts`;
  `brightenTowardWhite` itself is kept only because `drawRouteSignalBand` still uses it for the traveling
  signal's own glow stroke, which is unrelated to badges). None of the above were judged wrong on their own
  terms — the border design worked, the colour-flush design worked — they were judged unnecessary once it was
  clear the route highlight already carries all the route-identity information a badge needs:
  **revenue badges carry no colour of their own, ever; they are transient, colour-blind reaction surfaces
  only, and now react by moving rather than by tinting.**

Shipped (current design):

- the traveling signal is sampled by re-parsing the SAME authored SVG `d` strings `drawRouteOverlays` already
  strokes as Path2D (a Path2D has no point-at-length query) into line/cubic primitives, walking each route's
  hexes with the identical entry/exit-edge derivation and calling the same exported rail-selection functions
  (`artworkPathsForTraversal`, `printedPathsForEdge`, `railTruncatedAtMarker`, …) `drawRouteOverlays` itself
  uses — the two can never select a different rail for the same hex;
- every current route animates simultaneously, each its own independent loop: position is derived each frame
  as `elapsed_time × ROUTE_SIGNAL_SPEED_UNITS_PER_SEC` against a precomputed cumulative length in
  scale-invariant unit-hex-space (board pixels applied only at sample time), so a route's duration is a
  function of its own length against one shared speed, and pan/zoom/resize never rebuilds the track;
- revenue-stop → badge mapping uses a sequential two-pointer subsequence match (`matchRevenueStopsToPath`)
  against `SandboxRouteBreakdown.stops`' own path-ordered, per-city-deduplicated list — zero tile-ID or
  hex-label hardcoding, zero modification to the authoritative pricer; a hex visited twice for two distinct
  cities (an OO/double-city hub) claims two separate events off two separate occurrences in the path, never
  collapsed onto one; the arrival distance used is the hex's own physical revenue-marker position
  (`markerArcOffset`/`markerSegmentOffset`, the 2026-09-20 correctness audit), not the segment's far edge;
- when a route's travelling signal reaches a matched revenue stop, `badgePopScale` derives that badge's
  current scale from a three-phase attack/overshoot/settle curve (60ms / 130ms / 260ms, smoothstep-eased) and
  `drawValueBadgeAt` applies it as a single `translate → scale → translate` transform pivoted on the badge's
  own centre, wrapping both the shape and the text so they scale together; a badge with multiple revenue
  centres can react multiple times per pass, once per matched event, independently;
- two or more arrivals at the same rendered badge within `BADGE_HIT_COINCIDENCE_WINDOW_MS` collapse into one
  stronger pop (`selectBadgeHitReaction`), judged purely on each arrival's own real-elapsed-time timestamp
  (`mostRecentArrivalMs`) so it is correct across loop wrap-around and blind to which train produced which
  arrival;
- an actively-popping badge is drawn in a short late pass (`activeBadgeRedraws`) immediately after
  `drawStationTokenPass()`, so it clears nearby station-token artwork while reacting without disturbing the
  resting draw order any other frame relies on;
- lifecycle rides `routeOverlays.length > 0`, a signal that already existed for free: `App.tsx` already
  empties `routeDrafts` (and therefore `routeOverlays`) the instant a corporation leaves the "Routes"
  subphase, so no new prop was needed to start on activation and stop on end with no stale state;
- editing a route mid-Run-Routes reassigns badge reactions and rebuilds animated paths without restarting
  unaffected routes' loops: a per-`trainIndex` content signature is compared on every overlay-identity
  change, and only a train whose own signature actually changed has its loop-start and pulse-arrival state
  reset — stale instances never accumulate, since the cache is pruned of any `trainIndex` no longer present;
- `prefers-reduced-motion` (the same `window.matchMedia` idiom used everywhere else in this file) keeps every
  badge at its ordinary plain white/black rest state and the route lines static, but suppresses the
  traveling signal band and every badge-hit reaction entirely — no pop and no colour flush substitutes for
  either.

**Open, deliberately — playtest variables, not tuned further per the brief's own instruction:**
`ROUTE_SIGNAL_SPEED_UNITS_PER_SEC` (3.2, chosen so a representative 5–6-hex route lands near 1.5–2s),
`ROUTE_SIGNAL_PULSE_DURATION_SEC` (0.35s — now purely a bookkeeping window bounding how long a hit's
reaction-tracking state stays "live", not a visual fade duration), the traveling band's span
(`min(totalLength × 0.14, 0.4)` unit-hex-lengths) and its glow/core stroke widths in `drawRouteSignalBand`,
whether the 111%/117% peak sizes feel right at real running speed, whether 260ms feels connected to (or
disconnected from) the traveling signal's own speed, and whether the 98.5%/97.5% undershoot is perceptible
and reads as "settling" rather than as jitter. See Part F.

### VF-3 — Corporation float sequence

**IMPLEMENTATION COMPLETE, awaiting visual playtest after rules hardening.** Built on Approach C (A-1, as
amended above): the actual corporation-card DOM node lifts, translates and scales toward the Stock Round's
own centre, takes the FLOATED stamp, flips, and returns — all inside `StockRoundPanel.tsx`'s existing render
tree and the existing `uiScale` zoom, with no portal, no `position: fixed` escape, no second animation
registry and no duplicated card markup. Files: `components/corporationFloatFocus.ts` (new — the schedule,
mirroring `stockTransferFocus.ts`'s split), `components/StockRoundPanel.tsx` (the hooks, the geometry
measurement, the render), `App.tsx` (the edge detection and the cue). Tests:
`components/corporationFloatFocus.test.ts`, `components/corporationCardFloatFocus.test.tsx`.

Shipped:

- card-local float focus, panel-level state for the identical structural reason VF-1's transfer focus is
  panel-level (the cards are inline JSX inside one `.map`);
- Approach C's translate + scale, measured against the roster grid's own `getBoundingClientRect` inside the
  existing zoomed subtree — no viewport coordinates, no manual scale-factor conversion;
- the A-3 geometry-failure fallback: a full-motion sequence whose target could not be measured never enters
  the staged/transformed render path at all, and the card renders as the plain, already-floated,
  authoritative card with no lift, stamp or flip attempted;
- the SAME fallback silences the cue, not only the visuals: the stamp-impact timer that plays `floated.mp3`
  is scheduled off the sequence's own clock, independent of geometry, so it is gated by a render-updated ref
  (`floatCueGateRef`, read at fire time rather than passed as a reactive callback identity, so the gate can
  change every render without tearing down and re-arming the timer) rather than firing blind — a ceremony
  that never visibly played gets no sound either;
- a generated (SVG + `feTurbulence`/`feDisplacementMap`), not pasted-bitmap, FLOATED stamp, on the pre-float
  face only, removed from the tree (not merely hidden) at the flip's hidden midpoint;
- pre-float livery muted by `saturate()`, never `grayscale` — the whole card is never desaturated, only the
  livery stripe, and hue stays identifiable (design note #948's grayscale treatment is for a fully locked
  card and was deliberately not reused here);
- the staged `is_floated: false` → committed `true` swap at the flip's hidden midpoint, composed with VF-1's
  own `stagedOwnership` overlay via a plain object spread rather than a shared mechanism — the two focuses
  are independent and, per the cross-reference above, can both be live on the same card at once;
- a single restrained half-turn (the two-`rotateY` un-mirror trick), not a spin;
- `floated.mp3` on the stamp's impact beat, timing-owned by the card and played by the shell under the
  master SFX switch alone (#1457's split, no new category — same ruling as the presidency cue, C-6);
- reduced motion: no rotation, a brief centred scale and opacity dip, same semantic order, audio unchanged
  (VF-5's convention: sound stays under the preference);
- supersession via the same token/timer/render-time-reset pattern `useStockTransferFocus` uses (#1456);
  join/history/replay suppression for free, by riding the *same* `!previously.is_floated &&
  company.is_floated && !replayingHistory` edge `App.tsx` already trusts for the herald-home float modal and
  the Activity Log's `describeFloat` line, rather than a second computation of the same fact (A-4).

**Open, deliberately.** The translate/scale/flip is felt but not measured in `corporationCardFloatFocus.test.tsx`
the same way VF-1's row glide (C-10) is felt but not measured — jsdom reports every `getBoundingClientRect` as a
zero rect, so the geometry hook's A-3 fallback is exercised (and asserted) by every test in that suite, never
its measured branch. The translate distance, the flip and the stamp are therefore unverified by any automated
test and are the first thing to watch in playtest, exactly like C-10.

**Fixed during targeted testing, 2026-09-20.** Three bugs surfaced by `corporationFloatFocus.test.ts` and
`corporationCardFloatFocus.test.tsx`, none visible from reading the diff alone: (1) `CORPORATION_FLOAT_CSS`'s
reduced-motion comment used backtick-quoted code names (`` `StockRoundPanel.tsx` ``) inside the CSS template
literal itself, which closed the string early and broke every consumer of the module — stripped to plain
text; (2) the stamp-impact cue fired on the sequence's own clock even when the A-3 fallback meant nothing was
visibly shown (see the new "Shipped" bullet above); (3) `window.matchMedia = jest.fn().mockImplementation(...)`
in the new test file was never actually invoked by `prefersReducedMotion()`'s optional-chained call site in
this jsdom version — `stockCardFocus.test.tsx`'s own reduced-motion test uses a plain function assignment
instead, and the new test now follows that same established shape rather than `jest.fn()`. A fourth, cosmetic
find: the CSS attribute selector `[style*="saturate("]` used in the test's `mutedLivery` helper does not match
in this jsdom's `querySelector`; narrowed to `[style*="saturate"]`. `tsc --noEmit`, ESLint on the five changed
files, and the full `corporationFloatFocus.test.ts` / `corporationCardFloatFocus.test.tsx` / (pre-existing)
`stockCardFocus.test.tsx` trio (60 tests) are clean after these fixes.

**Audio cue realigned to the clip's own impact, 2026-09-20.** The freeze report above described the cue as
"`floated.mp3` on the stamp's impact beat" and meant it literally -- playback started exactly at
`FLOAT_STAMP_AT_MS` (480ms). Waveform-measured directly against the file in this repo (ffmpeg decode to raw
PCM, then a 10ms RMS envelope plus a whole-clip peak-sample search), `floated.mp3`'s own principal impact
sits at 458ms into the clip, not at its first sample -- corroborated by the loudest 10ms RMS window (centred
454ms) and the sharpest RMS rise (449ms), three independent measures inside a 9ms band. Starting the file
exactly on the stamp beat therefore put the clip's OWN impact near the flip's hidden midpoint (~930-980ms
absolute), not on the stamp. Fixed by moving only when playback starts, never the file and never the visual
timeline: `FLOAT_AUDIO_IMPACT_OFFSET_MS = 458`, and the cue now fires at
`FLOAT_CUE_AT_MS = FLOAT_STAMP_AT_MS - FLOAT_AUDIO_IMPACT_OFFSET_MS = 22`ms, so the clip's own impact lands
exactly on the unmoved 480ms stamp beat. Reduced motion cannot reuse this offset -- its own stamp beat
(`FLOAT_REDUCED_STAMP_AT_MS`, 160ms) is earlier than the clip's 458ms impact, so the same formula asks for
playback before the sequence exists (160 - 458 = -298ms); its cue now fires at the sequence's own start
(`FLOAT_REDUCED_CUE_AT_MS = 0`) instead, landing the clip's impact at the earliest this fixed-length clip
allows (458ms absolute, close to the 520ms swap midpoint rather than in dead air after the return settles).
Neither `stages` (the stamp's own visual landing, `FLOAT_STAMP_AT_MS`/`FLOAT_REDUCED_STAMP_AT_MS`), the audio
asset, nor any other beat of the 1800ms/840ms sequences changed. `tsc --noEmit`, ESLint, and the
`corporationFloatFocus.test.ts` / `corporationCardFloatFocus.test.tsx` pair (24 tests, three new/rewritten to
assert the offset math and the reduced-motion split) are clean.

### VF-4 — Phase transitions (mechanical phase badge flip)

**IMPLEMENTATION COMPLETE, awaiting visual playtest after rules hardening.** The EXISTING persistent phase
badge folds, swaps and unfolds when the DISPLAYED phase changes — a split-flap plate turning over, in its own
DOM node, in its own layout slot. No modal, no banner, no timetable, no duplicate plate, no consequence text.
Files: `components/phaseBadgeFlip.ts` (new — the schedule and the displayed-phase comparison, mirroring
`corporationFloatFocus.ts`'s split), `components/PhaseBadge.tsx` (new — the badge itself, extracted from the
bar's two inline spans, plus the timers and the staged face), `panels/ContextualActionBar.tsx` (both badge
call sites, and the new `phaseFlip` prop), `App.tsx` (the edge detection in the dispatch, the raiser, and the
two follow-on holds). Tests: `components/phaseBadgeFlip.test.ts` (26 cases),
`components/phaseBadgeFlourish.test.tsx` (10 cases).

Shipped:

- the trigger is a change in what the BADGE PRINTS — `GamePhase.label` + `.tint`, compared between
  `derivePhase(before)` and `derivePhase(after)` — never a change of train tier, so the Level Playing Field's
  7-train (Phase 6 either side, #1326) cannot produce a Phase 6 → Phase 6 ceremony;
- an unknown phase (`known: false`, `gamePhase.ts` #3) is not a phase at either end, so information arriving
  is not mistaken for a transition;
- derived in the dispatch from two settled states and guarded on `replayingHistory`, #1094's shape for
  #1094's reason: a `useEffect` on the derived phase sees every intermediate commit of a rebuild and would
  flip the badge 2→3→4→5 down a refresh. No stored previous, so nothing can go stale;
- `replayingHistory` rather than `isRemoteReplay`, so a live action arriving from another player's browser
  animates for everybody while a rebuild animates for nobody — the era toast's own distinction, one surface
  over;
- 200 ms fold → hidden midpoint → 260 ms unfold with a 6° mechanical overshoot → 60 ms settle; 520 ms total,
  inside the brief's 450–600 ms band;
- the staged `before` face until the hidden midpoint and the authoritative props after it (A-2), with no
  second phase authority anywhere: the new label and tint are read off the props on every render and never
  stored;
- a settle stage that carries NO class and NO transform, so the last frame is byte-identical to the ordinary
  badge — asserted by rendering the same component with no event and comparing `outerHTML`;
- reduced motion: an opacity crossfade in the same three stages, 200 ms total, no rotation attached at any
  point, plus a `prefers-reduced-motion` block in the stylesheet as belt and braces;
- supersession on the event's own token, so an Undo and a re-dispatch inside half a second replay rather than
  sitting finished;
- the era toast held to the badge's `faceSwapped` milestone and `PhaseThreeNoticeModal` to its `settled`
  milestone — NAMED beats resolved against the timeline actually being played, so the toast waits 200 ms and
  the notice 520 ms in full motion, 80 ms and 200 ms under reduced motion. `phaseBadgeTimeline` is the one
  source for both the sequence's own beats and the holds, so a hold cannot wait for a beat the badge is not
  playing. Both are presentation-only, through one shared timer helper cleared on unmount, and neither toast
  nor modal was rewritten: same door, same copy, same window, same edge.
  *(Corrected before freeze. The first cut used two fixed full-motion constants and defended them with
  "never early"; that bought a reduced-motion reader 120 ms of dead air before the toast and 320 ms before
  the notice — presentation time charged to someone who asked for less of it.)*

Part A, as applied: **A-1** — the badge animates in place, in its own subtree and the existing `uiScale`
coordinate system; no portal, no `position: fixed`, no duplicate badge (`phaseBadgeFlourish.test.tsx` asserts
`document.body` gains no child). **A-2** — the old face is on screen until the gesture hides it, so the change
is caused rather than explained. **A-3** — the reducer commits and the badge is handed the new phase before
any of this runs; a missing, superseded or absent event renders the plain authoritative badge. **A-4** — the
comparison reads two already-rendered values off two completed states, and `PhaseBadge` is handed a label and
a tint rather than a `GamePhase`, so it cannot consult a rule even by accident.

Deliberately NOT in this batch, because each already has an owner: rust and train-limit consequences
(`purchaseWarnings`), newly-legal tile colours (the era toast), the Phase 3 private-company rule
(`PhaseThreeNoticeModal`), lost trains (the FleetLoss systems). The flourish communicates one fact.

---

### VF-5 — Tile lay and tile upgrade

**IMPLEMENTATION COMPLETE, awaiting visual playtest after rules hardening.**
Design notes #1460–#1474. Files: `components/tileTransition.ts` (new — the description: pure, no canvas, no
rules), `components/tileTransitionCanvas.ts` (new — the painter), `components/HexGridRenderer.tsx` (the staging,
the tile being chosen drawn as a proposal, and the transition's sounds), `components/TileGraphics.ts`
(`printedTracksFor` exported), `components/hexCanvasPrimitives.ts` (`strokeTrackLayers` takes one ink or each path's
own), `utils/audio.ts` and `components/AudioControls.tsx` (the master sound switch mirrored where the board reads it,
#1474). Tests: `components/tileTransition.test.ts`, `components/tileTransitionStaging.test.ts` (109 cases),
`components/tileTransitionAudio.test.tsx` (11 cases: the board mounted and driven render by render, frame by frame);
`utils/previewTokens.test.ts` and `utils/roundTripPaint.test.ts` re-anchored on the proposal's branch of the tile
pass.

Shipped:

- a confirmed lay or upgrade transforms the hex from what it presented — a tile, or the printed artwork — into the
  new tile; a sent lay's held ghost (#1145) counts as presented, so a room plays it at the confirm;
- rail compared as pieces between edge midpoints and revenue centres: persistent rail stays still, reconfigured
  rail morphs with its city, and only genuinely added rail constructs — outward from what already stands;
- new rail built by a travelling construction wave (#1469): from its origin — the city it leaves, the rail it
  forks from, the edge a neighbour's rail reaches — a front travels the rail's own geometry, and each small
  portion behind it fades in, swells slightly heavier and settles to exactly the board's pen; branches from
  standing anchors build at the same time, and rail continuing from a node that was itself built starts when the
  wave arrives there;
- cities matched by the edges their rails reach, then by where they stand: capacity changes, migrations
  (Baltimore, Boston, New York's stubs, the OO spurs) and genuine merges (#54/#62 → #883, double towns into one),
  under fixed OO — the optional Variable OO Cities rule is not used, and nothing is specific to #59 (D-22);
- slot choreography from the destination's own slot geometry: one slot dividing (1→2, 1→3), several gathering
  and reorganising with no slot designated as the parent (2→3), merging cities reaching for each other as bodies
  until they are one (#1473);
- corporation tokens as pieces seated in their stations (#1472): each rides the slot that holds it through its
  city's own choreography — in a dividing slot until the split, gathering and overlapping with its neighbour in a
  reorganising city, travelling with a migrating or merging city — from where it stood to where authoritative state
  puts it; never split, merged, placed, or paired with a slot by geometry; a token the lay moves is shown faint at its
  planned place while the tile is being chosen, and that planned place waits under it until it settles there (#1473)
  — on a lay this board proposed only: another seat's lay rides its tokens in with nothing waiting for them (#1474);
- the tile being chosen drawn as a proposal (#1471): the whole destination tile at its facing, every printed colour
  washed toward one light neutral, opaque, dashed, with its value washed; turning it or cancelling starts nothing;
- a confirm that builds into the proposal (#1471): the transition starts from it, not from the old tile, and draws
  only what the lay changes over it — persistent rail stays the proposal's own, added rail erupts over its planned
  copy, reconfigured rail morphs into it, and a changing centre plays over its planned shape, which recedes;
- the commit last (#1471): a front crosses the hex in 240 ms from where the wash began, committing the tile behind
  it — fill, rim, rail, stations and value — while the geometry's last tenth settles under it; since #1473 it leans
  20° so the commit sweeps left to right and top to bottom, and its edge is a hairline on the tile's fill, under
  everything else on the tile;
- a 1600 ms span for the full sequence's spacing, every local beat at its own absolute length (#1464); the full
  sequence ends at 1328 ms, and a lay without some of the parts takes only its own parts' time — rail alone
  1052 ms, a commit alone 368 ms (#1470, #1471);
- home reservation markers ride their city as tokens do, a confirmed proposal's too, with no planned place: a marker
  the lay will move is left out of the proposal while the tile is being chosen (#1473); the hex's value badge follows
  the staged hex, and a confirmed proposal's value holds still;
- supersession is a snap; a board change or an unmount drops every transition; any failure draws the
  authoritative tile;
- a lay is staged once: a grid that lands it after the held ghost was dropped does not play it again (#1468);
- reduced motion (`prefers-reduced-motion`, #463's convention): a confirmed proposal fades to committed in 240 ms;
  a lay nobody proposed here crossfades from the old tile in 240 ms;
- first and last frames that stroke every line exactly once, so neither hand-over changes a line's weight;
- three sounds on the plan's own beats (#1474), through the helper every cue uses: `track.mp3` as genuinely new rail
  begins (`constructionStart`), `mutation.mp3` as a city gains a slot (`stationEmergence`), `upgrade.mp3` as the
  commit front starts (`revealStart`) — each once per transition, from the frame clock, never replayed by a frame, a
  repaint, the room's late grid or a superseded flourish; a tile being chosen, turned or cancelled is silent.

**Revised 2026-09-15, before freeze.** New rail erupts behind a travelling front instead of growing as a sectioned
stroke (#1469: D-3 resolved, D-23 opened; construction still inside 0.14–0.84 of the same 850 ms). The #59 →
brown OO facings that put both #59 cities into one brown city are recorded as rules-illegal under fixed OO, not
as merges (D-6, D-15, D-21, D-22); the merge evidence now stands on the genuine merges alone. Sweeps of what the
placement filter produces are called currently accepted transitions, not legal pairs. Tile-transition audio is
not wired.

**Re-timed 2026-09-16, before audio.** 850 ms became 1600 ms (#1464), with macro and micro time kept apart. The
major events — construction's start and travel, outline extension, slots spreading, the wash, the final settle —
are fractions of the whole and were spaced out; the local beats — the shake, a slot's pulse with its split and
gained slot, rings appearing, a rail portion's eruption — are absolute (`BEAT_MS`) and kept their approved lengths.
Nothing else changed: the same plans, first and last frames, portion counts and reduced-motion crossfade (D-1,
D-4, D-17, D-23, D-24).

**Unused phases collapsed 2026-09-16 (#1470).** 1600 ms is the full sequence, not a length every lay must fill.
Each transition's clock is derived from the parts its plan already records — construction, a station mutation,
geometry — with no tile ids and no table of recipes, and the wash begins when the last part present is ready for
it: colour alone after a 128 ms hold (640 ms in all); rail alone as its last portion settles (812 ms, 1324 ms in
all); a station mutation or geometry where the full sequence starts it (1088 ms, 1600 ms in all), because their own
long settles are what the full sequence waits for. Every placement and beat keeps its milliseconds, and the full
sequence is unchanged frame for frame. The plan now carries the semantic beats `constructionStart`,
`stationEmergence` and `colorWashStart` (D-24, D-25).

**Proposal and commit reveal 2026-09-16 (#1471), before audio.** The on-map preview was #822's ghost pass: the
finished destination in full colour over the board, so a confirm showed a finished-looking candidate, then the
old tile, then the flourish building the same tile again. The preview is now a proposal drawn in the tile pass by
the flourish's own painter (`proposedTileFrame`) — the whole destination, washed — and the transition a confirm
starts begins from exactly that frame, with the lay's differences active over it; the radial selector is
unchanged. The long wash is replaced by a 240 ms commit front, which also commits a new lay or a same-tier
replacement. A lay nobody proposed on this board (another seat's, a replay's) shows its proposal over the 128 ms
lead and then plays the same sequence. The plans, classes, construction, slot choreography and every micro beat
are unchanged; the committed last frame is #1470's to within one intensity level, and the beat `colorWashStart`
is now `revealStart` (D-1, D-2, D-8, D-11, D-12, D-14, D-16, D-17, D-24–D-31).

**Tokens seated 2026-09-16 (#1472), before audio.** A token had ridden its city's anchor and swung to its new slot
about it, apart from the rings (#1466), and #1471 then held a confirmed proposal's tokens at their final slots while
the city moved beneath them. A token is now a piece seated in its station: `tokenPositionAt` moves it with the slot
that holds it through the city's own choreography — the rings' own anchor, shake, gather reach and easings
(`cityMotion`, `GATHER_REACH`) — between its two authoritative places, which the renderer reads from
`stationTokenMark` together with the city index authoritative state gives the token on each tile; a slot is never
assigned to a token by distance, so a symmetric destination cannot swap two tokens. A confirmed proposal's tokens
start from their seats in the city's old drawing, where the city itself restarts. Every frame, plan, clock and beat
is unchanged — `stationEmergence` included, and every sampled frame identical to #1471's over all currently
accepted transitions — and so are reservation markers and the value (D-7, D-14, D-27, D-28, D-32, D-33).

**Pieces, merges and the commit's edge 2026-09-16 (#1473), before audio.** Refinements before the geometry and piece
motion freeze. **Reservation markers** ride the same seat as tokens (`reservationPositionAt`): a marker's city is
read from where the board draws it — its centre or one of its slots — and the marker rides that city's own
choreography, a confirmed proposal's markers too. **Planned places**: while a tile is being chosen, a token the lay
will move (`pieceMoves`) is drawn only at its destination, at 40% (`PROVISIONAL.pieceAlpha`); from the confirm that
planned place waits under every piece while the real token rides in from its seat, and fades with the commit as the
token settles on it (`pieceTargetPresence`). A token the lay does not move is drawn as before. Reservation markers get
no planned place — they are already drawn as faded tokens — so one the lay will move is left out of the proposal
until the confirm. **Merges**: the neck that joined merging cities grew from a line — a stroke thinner than a city's
ink band, all ink, which read as new rail between two cities; merging cities now reach for each other at a city's
full width and fuse (`reachingNeck`). **The commit's edge**: the front leans 20° with its top ahead (`REVEAL_SLANT`);
its edge is a hairline (1% of the hex size, at least 0.5 px) drawn on the fill, under the rim, the art and every later
pass; while it crosses, each side's art is laid on as a finished layer, so no seam of the art's lower strokes shows
along it. Plans, classes, construction, the clock, `plan.beats` and every beat are unchanged. Frame descriptions equal
#1472's but for merging cities' necks and the front's travel span; outside the commit's crossing the pixels are
#1472's but for one intensity level on some rim pixels, and every settled end is #1472's to the pixel (D-6, D-8,
D-14, D-26, D-27, D-28, D-30, D-32–D-35).

**Audio, and no planned places on lays nobody proposed 2026-09-16 (#1474).** The three clips in `public/audio` are
wired, unedited, to `plan.beats` as three independent triggers read off the plan (`tileTransitionCues`): `track` at
`constructionStart`, which exists only when the classification finds Added rail — once however many rails, branches or
origins build, and never for persistent or reconfigured rail, a migration, New York's merge or a commit alone;
`mutation` at `stationEmergence`, which exists only when a city gains a slot (1 → 2, 1 → 3, 2 → 3, a merge's added
slots); `upgrade` at `revealStart`, on every transition. Over the 67,308 currently accepted transitions: rail and
commit 63,763; rail, mutation and commit 2,284; mutation and commit 749; commit alone 512. The renderer sounds them from
its frame clock, keeping on each running transition a count of the cues it has dealt with (`cuesReached`), and only
while the draw shows that transition — before its end, and not under a proposal on its hex; a cue reached otherwise is
passed over, never played late. Supersession, a board change and an unmount drop the count with the transition; a clip
already ringing finishes. Everything goes through `playVariantCue` — the master switch, the shared level, the
three-clip cap, the radio's duck and the browser's refusals — and the switch, which only the shell held, is mirrored
into `audio.ts` by the one control that flips it (D-38). The clips are warmed when the board mounts (#1420). Reduced
motion builds and splits nothing, so it sounds only the commit, at its fade's first frame. **Planned places:** a token
the lay moves has one only where this board proposed the lay (`pieceTargetPresence` answers none otherwise); another
seat's lay, or a replay's, rides its tokens in from their seats with nothing waiting (D-34). Plans, clocks, beats and
every sampled frame equal #1473's, and so do token and reservation rides and a confirmed proposal's planned places
(D-8, D-24, D-29, D-34, D-36–D-39).

**Audio assets trimmed 2026-09-16 (after #1474; assets only, no code).** `mutation.mp3` and `upgrade.mp3` lost their
dead leading material; `track.mp3`, every cue trigger, `plan.beats`, the visual timing and all audio code are unchanged.
One rule for both, read off each file's own waveform: everything before the first 10 ms in which the clip comes within
40 dB of its own loudest 10 ms is removed, the cut at a zero crossing with a 2 ms raised-cosine fade-in. Nothing is
taken off the end: a second pass, rebuilt from the untouched originals with the same cuts, ends each clip in an 8 ms
raised-cosine fade to digital zero, where both had stopped on a hard edge near -40 dBFS. From `mutation.mp3`, 1,369.9 ms
— 1,337 ms of exact digital silence, 13 ms of decoder residue below -100 dBFS, and a 20 ms lead-in no louder than
-44.8 dBFS: it now sounds above -40 dBFS within 7 ms of playback, reaches its hit by 27 ms and peaks at 44 ms, and lasts
231 ms decoded (264 ms as an MP3) instead of 1,601 ms (1,632 ms). From `upgrade.mp3`, 93.1 ms of lead-in between -70 and
-50 dBFS: its riser is above -40 dBFS from 10 ms, its brightest hit peaks at 130 ms and its loudest 10 ms start at
184 ms — both inside the 240 ms sweep, where they had fallen at 223 and 277 ms — and it lasts 842 ms decoded (888 ms)
instead of 935 ms (960 ms). Each file is the original decoded audio from its cut on, re-encoded at 320 kbps CBR, 48 kHz
stereo, with its title and track tags; level, spectral centroid, length and every onset are unchanged by the fades. The
untrimmed files are kept in `public/audio/_untrimmed/`, beside the other trimmed clips' originals (D-24, D-36, D-39).

**Railroad work: the reconfiguration moves first, 2026-09-18 (#1475).** Where existing geometry reconfigures AND new
rail is added — a B-style upgrade above all — the two overlapped from the first frame: the geometry's settle opened at
128 ms and the eruption started at 200 ms, with the settle 0.9 % travelled (Baltimore's city had moved under a
hundredth of a pixel). Now a transition that RECONFIGURES — rail that reforms by at least half a rail width or is taken
up (`trackWork`), or a revenue centre with a predecessor whose drawing moves that far — opens its construction window
where the settle has carried the existing geometry a quarter of its way (`RECONFIGURE_ESTABLISHED`, read back off
`settleEase`): 433 ms instead of 200 ms, a 305 ms head start, with three quarters of the movement still to come, so the
two run together to the commit. Every other transition keeps the table's own 200 ms, and no transition's length
changes: the stagger fits inside the construction window the table already reserves, and the wave still settles by the
reveal (1045 ms against 1088 ms). **`track.mp3` now means railroad work has begun,** not "new rail is being built":
`railroadWorkStart` is the earliest of existing rail reforming (the geometry window), rail being taken up (the vanish
window) and the first added rail, and the clip sounds there once — a B-style upgrade sounds it as its track starts to
reform and adds nothing when the eruption follows; an ordinary lay sounds it exactly where it did. A station's rings,
a token, a reservation marker, the commit front, a city re-laid where it stood and a colour-only change are not
railroad work. LPF town fusion gets the track cue and no `mutation.mp3`; New York's #54 → #883 gets the track cue from
the same generic question (its four rails reform 0.5 of the hex) and keeps its mutation beat (D-40).

**VF-5's stale fixture repaired 2026-09-18 (test only, after Stage 9.2).** D-19's Baltimore facings are gone, and with
them the only transitions the old `resolves an unexpected pair to the destination with no orphaned stroke` fixture
could select: it chose its facing by `removed > 0` and threw once Stage 9.2 refused them. Both of the strategies D-19
sets out were taken, and no legal transition with `removed > 0` was sought — there is none. The gameplay claim is now
made over a legal transition, Plus `I15 → #53@0`, a genuine re-pairing of Baltimore's printed curve into #53's spokes
(measured `persistent 0, reconfigured 2, added 1, removed 0`), as *lands a legal re-pairing of track on the destination
with no orphaned stroke*; the renderer's `removed` arm keeps a case of its own, *resolves an unexpected pair to the
destination with no orphaned stroke (synthetic, renderer-only)*, whose plan is built by hand (#8@0 → #9@0) and labelled
in the test as synthetic, renderer-only, non-gameplay and not produced by legal tile placement. Nothing outside that
one test file changed: no legality, classification, timing, beat, audio or renderer behaviour (D-19 closed).

Part A, as applied: **A-1** — nothing leaves the hex; **A-2** — a layout effect starts the transition before the
new state is painted, so the finished tile never appears first; **A-3** — gameplay commits immediately and
nothing waits on the flourish; **A-4** — `tileTransitionStaging.test.ts` scans the description and the painter
for rules imports, dispatch, timers and tile-id comparisons.

**Candidate standing constraint, for the owner to rule on before VF-2/VF-4:** a board flourish holds only what
its hex needs, draws in the owning pass's place, and hands the hex back to that pass by time.

---

### VF-6 — Bank break (railroad-ticket endgame countdown)

**IMPLEMENTATION COMPLETE, awaiting visual playtest after rules hardening.** The Bank indicator becomes ONE
continuous strategic object across three states: absent while the Bank is comfortable, an amber then crimson
countdown of DOLLARS as it approaches, and — at the break — the same ticket, stamped, counting OPERATING
ROUNDS. Files: `utils/bankBreakEndgame.ts` (new — the authoritative ORs-remaining derivation),
`utils/bankBreak.ts` (`bankTicketReading`, the three-state composer; `bankBreakWarning` and its thresholds
untouched), `components/bankBreakFlourish.ts` (new — the ticket silhouette, the rainbow ring, the stamp
schedule), `components/BankTicket.tsx` (new — the badge, extracted from the bar's two inline capsules),
`panels/ContextualActionBar.tsx` (both rails, plus the two new props), `App.tsx` (the edge, the raiser, the
spectator dock, and the removal of #901's Top Bar badge), `styles/appStyles.ts` (`bankBrokenBadge` retired).
Tests: `utils/bankBreakTicket.test.ts` (26 cases), `components/bankTicketFlourish.test.tsx` (21 cases);
`utils/bankBreak.test.ts` and `utils/bankBreakLatch.test.ts` each amended by one case, with the reason
recorded in place.

Shipped:

- **one silhouette, three tones.** A period railway-ticket outline — four chamfered corners via `clip-path`
  and a single dashed stub rule via `::before` — carried in every state, so the break reads as the ticket
  being stamped rather than as one badge replacing another. Two cues and no more: at `FONT_SIZE.micro` in a
  crowded bar, a punch hole or a paper texture is noise that reads as a rendering fault;
- **the latch decides, and it decides first.** `bankTicketReading` takes the broken arm before it so much as
  reads the balance, so the owner's own `$10 → pays $30 → receives $100 → $80` never gets its dollar
  countdown back. The dollars do not return while the latch stands, at any balance;
- **the ORs-remaining count is read off the reducer's own calendar**, never decremented locally. Case A (a
  break during an Operating Round) is the round in progress plus the rest of its **locked** set
  (`operatingRoundSequenceLength`, #511 — a phase that moved mid-set must not add a phantom round); Case B (a
  break during a Stock Round, or the delayed auction that can occupy that slot, #905) is the whole upcoming
  set, `operatingRoundsForPhase(derivePhase(state))`, which is exactly what `beginOperatingRound` will stamp.
  Singular at one round, plural above it, and **never zero**: at that boundary #898 has already produced
  `GameEnd` and #1442's game-over strip has already taken the bar's slot;
- **the post-break tone is the application's existing special-event language**, not a new palette. The ring
  is `PRIVATE_POWER_GLOW_STOPS` — #727's shared hue circle, the same one a player has met ringing a contested
  mini-auction card (#320/#344) and haloing a private-power hex — drawn with #320's own two-layer
  `background-clip` technique so the gradient is a RING and the interior stays dark. That is what keeps the
  text at full contrast over it, which a rainbow fill would not;
- **static, deliberately.** #320 animates a chase and defines its own reduced-motion form as "the multicolour
  ring stays, static"; the brief says "do not animate indefinitely after the break". Those agree, so the
  resting ticket takes the treatment's existing still form. The critical pulse stops at the break too — it
  means "act before this lands", and it has landed;
- **one-time BANK BROKEN stamp**, 960 ms: a 200 ms draw-in, the stamp landing at 200 ms and holding, the
  commit to rainbow at 540 ms as the stamp lifts, and an 80 ms settle carrying no class and no animation.
  The ticket is staged CRITICAL from the first frame and turns rainbow exactly once, in the direction the
  event actually went — never rainbow, then red, then rainbow;
- **reduced motion**: the same four stages by opacity alone, 470 ms total, no scale and no travel anywhere.
  The stamp still arrives (#26: a cue that disappears under reduced motion is an information problem). Every
  dependent beat is a NAMED milestone (`stamped` / `committed` / `settled`) resolved against the active
  timeline, which is VF-4's correction applied from the start rather than after the fact;
- **edge discipline**: `!bankIsBroken(before) && bankIsBroken(after)`, derived in the dispatch from two
  settled states, guarded on `replayingHistory` at the dispatch site and again inside the raiser. First
  observation seeds nothing because nothing is stored; a refresh into a broken game shows the persistent
  ticket and no stamp; a rebuild never stamps; an Undo past the break restores the dollar countdown for free,
  because the rebuilt state never reached the latch (#1561's own argument); a live remote break stamps for
  every player, which `isRemoteReplay` could not have distinguished from a rebuild;
- **accessibility**: the rainbow is never the only indication. The label says `BANK BROKEN` in words and
  carries the count; `aria-label` carries the same fact at length; nothing animates after the settle.

Part A, as applied: **A-1** — the ticket animates in place, in its own node, inside the existing `uiScale`
subtree; no portal, no `position: fixed`, no duplicate ticket. **A-2** — the critical ticket is on screen and
takes the stamp before the rainbow exists, so the gesture causes the final state. **A-3** — the latch was
written by `cashLedger.debitBank` inside the reducer arm before any of this runs; a missing, superseded or
absent event renders the plain authoritative ticket. **A-4** — `BankTicket` is handed a READING, not a game
state: it cannot consult the latch, the balance or the round machine even by accident.

**Reducer untouched.** No change to the bank-break rule, the latch, `settleRoundTransitions`, money
accounting or `GameEnd` semantics. `bankIsBroken` and `operatingRoundSequenceLength` are called, never
reimplemented.

---

### VF-7 — Rust (corrode / fracture / remove train chips)

**IMPLEMENTATION COMPLETE, awaiting audiovisual playtest after rules hardening.** A rusting train chip
oxidises, fractures along a jagged procedural crack, fails with one small shudder and leaves; its slot is
held until it is invisible, and only then does the row close. Files: `components/trainRustFlourish.ts` (new
— the event shape, the schedule, the crack generator, the stylesheet), `components/TrainBadges.tsx` (the
staging hook, the per-chip rendering, two new props), `components/ContextualSubPanel.tsx` and
`panels/ContextualActionBar.tsx` (the two live Operating Round surfaces), `App.tsx` (the raise, the tutorial
gate, the modal hold), `utils/fleetLossNotice.ts` (the rust silence retired),
`components/FleetLossModal.tsx` (no checkbox for a cause with no opt-out),
`components/TutorialModal.tsx` (a control for tutorial mode). Tests:
`components/trainRustFlourish.test.ts` (30 cases), `components/trainRustChips.test.tsx` (12 cases);
`utils/fleetLossNotice.test.ts`, `utils/batch37.test.ts` and `components/phaseBadgeFlip.test.ts` each
amended, with the reason recorded in place.

Shipped:

- **rust is destruction and must not look administrative.** The vocabulary is deliberately the opposite of
  the train-limit discard a later batch will build: nobody chose, nothing is recoverable, the train has left
  the game. #896 split the two by cause in the copy; this keeps them split in the motion;
- **the trigger is the existing narrators' own answer** — `describeFleetLosses` and
  `describeReprieveExpiries` (#704, #1002, #1099) — never a phase tier, a model number or a warning
  disappearing. Exact corporation, exact models, exact multiplicity;
- **and it is intersected with an observable destruction.** `destroyedRustedModels` keeps only the models
  that actually left `owned_trains` between the two settled states. This was found by running the Gentle
  Rust case: `describeFleetLosses` reports newly MARKED trains as `rusted` under that variant, deliberately
  (#979), so collecting `loss.rusted` directly would have fractured chips that are still in the fleet —
  exactly what the brief forbids. A destruction test rather than a `!gentleRustOn` guard, so a marking
  yields nothing, an expiry yields everything, and no variant is named anywhere in the shell;
- **staged before-roster.** The row draws the fleet AS IT WAS — the event carries `before` — rusts the chips
  that are leaving, holds their slots until they are invisible, and only then falls through to the
  authoritative roster. Both the row's own "none" placeholder and the action bar's outer one had to learn
  this, because a corporation can lose its whole fleet to one rust and either guard alone loses that case;
- **190 ms oxidise → fracture at 190 → fail at 330 → slot given up at 450 → settled at 530**, inside the
  brief's 450–600 ms band. The oxide is burnt iron (`rgba(107, 63, 42, …)`, `#8a4a2f`), never bright orange,
  glow or sparks, and the model stays readable through the fracture;
- **the crack is procedural, deterministic and resolution-free.** An SVG path in a 0–100 box with
  `preserveAspectRatio="none"`, seeded from the corporation and the chip's position: one main fracture that
  changes direction four times plus one branch leaving an interior vertex. Seeded because the chip
  re-renders on every stage boundary and a `Math.random` crack would redraw itself mid-fracture;
- **failure is three pixels and no more** — one shudder, a few pixels of separation, opacity to zero. No
  explosion, no debris, no physics, no arcade shake;
- **one event across every corporation, on one clock.** No stagger at all: see H-4 below for why that is a
  decision rather than an omission;
- **Tutorial ON keeps the explanatory modal; Tutorial OFF has no click-through.** The Activity Log line is
  written above the gate and outside it, under both settings — #896's standing rule that silencing changes
  WHEN a player finds out, never whether the game told them;
- **the Tutorial modal waits for the chips to finish**, on the `settled` milestone of whichever schedule is
  playing (530 ms full motion, 240 ms reduced). A hold on the SHOWING, not on the queueing, so nothing is
  lost to a refresh and #1032's replay-stable dedupe key is untouched;
- **reduced motion**: same four beats, 240 ms, no shudder and no fragment travel; the oxide and the crack
  both stay and only the crack's propagation goes (#26 — a cue that disappears under reduced motion is an
  information problem);
- **edge discipline**: raised from two settled states under `replayingHistory`, nothing stored. First
  observation stages nothing because there is no previous roster to compare; a rebuild never fractures; an
  Undo past the rust restores the fleet for free; a live remote purchase animates for every player.

Part A, as applied: **A-1** — the chips animate in place, in the existing chip DOM and the existing `uiScale`
subtree; no portal, no `position: fixed`, no duplicate fleet renderer, no second fleet authority
(`trainRustChips.test.tsx` asserts `document.body` gains no child). **A-2** — the pre-rust fleet is on screen
and fractures before the authoritative roster is shown. **A-3** — the reducer rewrote the fleets before any
of this ran; an unknown roster, an absent event or a superseded one renders the plain authoritative row.
**A-4** — `TrainChips` is handed an event and a company id, never a rule: which trains rust stays entirely
the narrators' answer.

**Reducer untouched.** No change to which trains rust, when standard rust destroys, Gentle Rust timing, phase
rules, train-limit rules, route legality or reducer fleet authority.

---

### VF-8 — Train-limit discard (clean cut / transfer to Bank Pool)

**IMPLEMENTATION COMPLETE, awaiting audiovisual playtest after rules hardening.** The chip the president
chose draws in under a blade, is cut once by a single straight near-vertical line, parts into two halves by
three pixels, and both halves leave together toward the Bank; the slot is held until they have arrived, and
the Bank Pool's returned-train row pops once if the purchase panel happens to be open. Files:
`components/trainDiscardFlourish.ts` (new — the event shape, the schedule, the cut geometry, the
stylesheet), `components/TrainBadges.tsx` (a second staging hook beside the rust one, the split-chip slot, a
new prop), `components/ContextualSubPanel.tsx` and `panels/ContextualActionBar.tsx` (threading),
`components/TrainPurchasePanel.tsx` (the receiving reaction), `App.tsx` (the raise off the action, the
tutorial gate, the modal hold), `utils/fleetLossNotice.ts` and `components/FleetLossModal.tsx` (the silence
store retired outright). Tests: `components/trainDiscardFlourish.test.ts` (42 cases),
`components/trainDiscardChips.test.tsx` (21 cases); `components/trainRustFlourish.test.ts`,
`utils/batch26.test.ts`, `utils/routeChipDetail.test.ts` and `utils/fleetLossNotice.test.ts` each amended,
with the reason recorded in place.

Shipped:

- **every channel is inverted against VF-7, deliberately rather than incidentally.** 6.6.1 is precise about
  what this event is: the president CHOOSES, the train leaves for the Bank Pool, nobody is paid, and anyone
  may buy it back at face value. Nothing broke. So rust's jagged branching fracture becomes one straight
  line; rust's burnt-iron oxide becomes no new colour at all (the blade is `currentColor`); rust's shudder
  and rotation become a three-pixel separation on one axis; and rust's dissolution in place becomes a
  departure, together, toward the bank. **No part of VF-7 is reused** — no `crackPath`, no oxide keyframe,
  no `app-train-rust-*` class — because two vocabularies sharing an implementation drift into looking
  alike, which is the one outcome that would make both useless;
- **the trigger is a successful authoritative `DiscardTrain`, read off the MESSAGE and not off a diff.**
  This is the batch's audit finding: `describeFleetLosses` deliberately splices a `DiscardTrain` out of its
  narration (#1530 — "narrated by the Activity Log as the action it is, not as a loss the phase took"), so
  the fleet diff reports nothing here and a flourish built on it would never have fired at all. The message
  names the model the president picked; `discardedOccurrence` — literally the reducer's own
  `owned.indexOf(model_type)` — resolves it to the slot the reducer will empty;
- **and a refusal is invisible to it.** `before !== after` is the reducer's own refusal signal (#778: every
  gate refuses by returning the state it was handed), so a discard the gate declined — wrong corporation,
  not its president, a train it does not hold — reaches the raiser as an identity and animates nothing.
  Verified against the real reducer rather than asserted;
- **no cheapest-first, anywhere.** #1530 replaced the engine's cheapest-first trim with the president's
  explicit choice precisely so the president chooses; nothing on this path reads a price, a tier order or
  an age, and the only lookup is for the model the message already names. Pinned as an absence over both
  the module and the raiser;
- **duplicate models are one train each.** `["3", "3", "5"]` discarding a 3 cuts the copy the reducer will
  take and leaves the other 3 and the 5 continuously present, with a stable staged identity and a stable
  blade across every stage render. The occurrence comes from the reducer rather than from a second match
  made here, so the two cannot disagree the day the arm's tie-break changes;
- **the halves are siblings, not children.** A `clip-path` clips its element AND its descendants, so a chip
  clipped to its own left half cannot contain its own right half — the obvious arrangement is the one
  arrangement that cannot work. During the split the row renders a slot in the chip's own place: the left
  half in normal flow (which is what keeps the slot reserved at the chip's size) and the right half
  absolutely positioned over it, `aria-hidden` so one chip is not read out as two trains;
- **80 ms tension → cut at 80 → part at 120 → transfer at 200 → slot given up at 360 → settled at 500**,
  inside the brief's 450–600 ms band. A third of the length is spent leaving, which is where rust spends
  nothing: rust has no destination;
- **the slot is given up when the train has ARRIVED**, not when it starts moving — VF-7's rule for VF-7's
  reason, and here it is also the instant the Bank Pool is told it has received something, because that is
  the same event seen from the other end;
- **Bank Pool destination: the brief's Option B.** Audited first: pooled trains render only as rows in
  `TrainPurchasePanel`, on the Buy Trains step, for the acting corporation's president — so a discard
  answered off-turn has no visible destination at all and a literal flight to it (Option A) would be an
  animation toward something that is not on screen, and would need A-1's portal to reach it. So the
  departure is complete on its own, and the arrival is a one-shot scale pop on the matching returned-train
  row when the panel happens to be open, keyed on the event token so a second discard replays it;
- **Tutorial ON keeps the explanatory modal; Tutorial OFF has no click-through**, and the modal waits on
  the `settled` milestone of whichever schedule is playing (500 ms full motion, 260 ms reduced) so the cut
  has fallen and the halves have arrived before a top-layer dialog can cover the row. The Activity Log line
  is the reducer's narration and is not gated;
- **the explanation was re-homed, because its old home is unreachable.** #896's limit notice was queued off
  the phase-change fleet diff, and #1530 made that path dead in the same breath as it created this action.
  Audited by running the reducer, not by reading it: `describeFleetLosses` returns `[]` at the phase change
  (the phase takes nothing) and `[]` on the discard (the message is spliced out), so the Train Limit modal
  has not fired for any v2 dispatch. Same `FleetLossNotice` shape, same copy (#704/#980), same
  replay-stable dismiss key (#1032) — raised from the action the president just took, which is also the
  only place the chosen train is known;
- **and the silence machinery is therefore retired outright** (see I-1, revised). VF-7 narrowed it to the
  limit cause because that half still had a real reader; it does not, and now it has its own vocabulary
  besides. `isNoticeSilenced`, `setNoticeSilenced`, `resetNoticeSilenceCache`, `silenceLabel`,
  `isSilenceable`, `SilenceableCause` and the storage keys are all gone; `nextDueNotice` takes the queue
  and the dismissed set; `FleetLossModal` has no checkbox. One system decides whether either dialog
  appears, and it is the tutorial setting;
- **reduced motion**: same four beats, 260 ms; no split, no travel, no shudder. **The cut stays** — it is
  the whole semantic difference from a rust, and a cue that disappears under reduced motion is an
  information problem (#26) — but it is present rather than falling, a mark instead of a movement;
- **edge discipline**: raised inside the dispatch from the two settled states, guarded on the module-level
  `replayingHistory` (#1094) at the condition and again at the raiser's own door. A rebuild never cuts, an
  Undo past the discard restores the fleet for free, and a live remote discard animates for every player.

Part A, as applied: **A-1** — the cut, the split and the departure all happen in the chip's own place in the
existing chip DOM and the existing `uiScale` subtree; the slot wrapper exists for ~240 ms and only for the
one chip that is leaving; no portal, no `position: fixed`, no second fleet renderer
(`trainDiscardChips.test.tsx` asserts `document.body` gains no child). **A-2** — the pre-discard fleet is on
screen and is cut before the authoritative roster is shown. **A-3** — the reducer rewrote the fleet and the
pool before any of this ran; an unknown roster, an out-of-range occurrence, an absent event or a superseded
one renders the plain authoritative row. **A-4** — `TrainChips` is handed an event and a company id, never a
rule: which train left stays entirely the reducer's answer, taken from its own `indexOf`.

**Reducer untouched.** No change to when a corporation is over the train limit, who chooses the discarded
train, discard ordering between corporations, which trains are eligible, Bank Pool behaviour, train prices,
reducer gates or round flow.

---

### WM — Warning marks (static semantic identifiers)

**IMPLEMENTATION COMPLETE, awaiting visual playtest.** NOT A FLOURISH, and it is listed apart from the
VF batches for that reason: nothing here moves. It is the identification pass the flourishes made possible
— now that each event has a vocabulary in motion, the badges at rest can borrow from it.

**The problem, exactly.** Rust and Train Limit sit in the same warning capsule, escalate on the same
countdown (#867), and both opened with `⚠`. So the only thing telling them apart was the sentence, and a
row of identical amber pills that must be READ is a row not doing the job a badge is for.

Shipped:

- **colour is untouched, and that is the constraint the pass is built around.** `ALERT_WARN_*` and
  `ALERT_CRITICAL_*` mean two-buys and one-buy on every surface in this app — the bar, the chips (#7), the
  private pills (#1035). A rust-brown badge and a limit-blue one would make one channel answer two
  questions (#732) and cost the escalation the only channel it owns. Urgency stays colour; classification
  moves to a mark;
- **one mark, never a mark plus a `⚠`.** The generic glyph said "this is a warning", which the colour had
  already said, so it was spending the badge's first character on the thing least in doubt. Gone from all
  three badges that gained a mark; the Bank ticket keeps its own (VF-6, untouched);
- **rust is VF-7's own crack, at a fixed seed** — `crackPath(41, 3)` inside a light rounded tile, which is
  I-10's prediction taken literally ("a badge icon can be the same mark at a fixed seed"). Identity rather
  than resemblance: the test asserts the mark IS the generator's output mapped into the tile, so a change
  to what a fracture looks like moves the badge with it;
- **`crackPath` gained an optional `steps`, defaulting to 4**, so VF-7's chips are byte-identical and the
  badge asks for less detail from the same rule rather than getting a second generator;
- **the train limit shows the capacity itself — `4→3`, `3→2`.** More informative than any icon and
  self-distinguishing from a crack. And not redundant: #889 moved the figures OUT of this badge's label
  ("Limit X → Y in N Buys" was "the busiest string in a row of badges") and into `detail`, so the mark
  restores the missing half at a fraction of the width;
- **the figures are carried, not parsed.** `PurchaseWarning.capacity` holds `phase.trainLimit` and
  `limitAfterNextPhase` — the same two values the rule is decided on, at the moment it is decided. A regex
  over "lowers the train limit from 4 to 3" would have made the copy load-bearing, and #889 and #1033
  between them have rewritten these strings three times;
- **a fallback capacity-down glyph, and no invented numbers.** Unreachable from the bar today —
  `purchaseWarnings` builds the warning only inside `if (after !== null && after < phase.trainLimit)` — and
  kept and tested anyway, because #788 objects to an arm nobody can explain rather than to one that is;
- **the Gentle Rust final-run badge takes the rust mark too** (see K-1);
- **accessibility unchanged.** The badge still carries `aria-label={warning.detail}`, the whole sentence;
  both marks are `aria-hidden` and `focusable="false"`, because a mark announced separately would be a
  second, worse telling of something the reader has already had;
- **everything is sized in `em`.** The chrome is zoomed as one object (`chromeZoomFor`), so a mark sized
  against its own label holds its proportion at 0.63, 1.0 and 1.5 with no breakpoint anywhere. There is
  nothing scale-dependent left to get wrong — only a readability question, which is K-2.

**The one that had to be found by looking** (and the reason K-2 is a playtest item rather than a
formality). Two hundred seeds were scored at `steps: 2` on turn angle, branch length and branch angle;
seed 18 won every metric. Rasterised at 120px it is an analogue clock at about 7:35 — two steps leaves one
interior vertex, the branch leaves from an interior vertex, so the figure can only be three limbs from one
point in a rounded square. "Time remaining" is very nearly a meaning a countdown badge could carry. The
metrics were measuring the parts and missing the gestalt. The candidates were then drawn out at 9, 12, 16,
26 and 110px, framed and unframed, and chosen by eye: `steps: 2` with no branch is a prohibition sign,
`steps: 4` is a descending staircase, a chip-aspect oblong frame squashes the fracture into a smudge below
~16px, and no frame leaves a stray hair. **For the next pass: a 0–100 generator's parameters do not predict
what it looks like at 13 pixels.**

**Untouched.** Purchase-warning thresholds, phase logic, Rust rules, train-limit rules, Bank Break
behaviour, warning copy, and pulse/escalation timing. The Phase badge and the Bank ticket were not
redesigned.

Files: `components/WarningMarks.tsx` (new), `components/trainRustFlourish.ts` (one optional parameter),
`utils/purchaseWarnings.ts` (one carried field), `panels/ContextualActionBar.tsx` (three render sites).
Tests: `components/warningMarks.test.tsx` (22 cases).

---

### AW — Audio wiring (Bank Break, Rust, Train-Limit Discard)

**IMPLEMENTATION COMPLETE, awaiting audiovisual playtest.** Three supplied assets wired to the three
flourishes that audited silent. Every one of those audits ended the same way — the tree had the right
envelope only in clips `variantSfx.ts`'s flavour-text matcher already owned — so all three are new files
rather than borrowed ones, and `iec-crack.mp3` keeps its ice and `camera-shutter.mp3` its photograph.

| cue | file | principal impact | milestone | cue starts (full) | cue starts (reduced) |
|---|---|---|---|---|---|
| Bank Break | `bank-broken.mp3` (1.36s) | 12 ms | `stamped` (200 / 90) | 188 ms | 78 ms |
| Rust | `rust.mp3` (2.00s) | 100 ms | `fractured` (190 / 90) | 90 ms | 0 ms (10 ms late) |
| Train Limit | `train-discard.mp3` (2.00s) | 69 ms | `cut` (80 / 40) | 11 ms | 0 ms (29 ms late) |

Shipped:

- **the clip's own impact lands on the milestone, not its first sample.** VF-3's method for `floated.mp3`,
  run again: ffmpeg decode to raw mono PCM, then a whole-clip peak-sample search plus a 10 ms-window RMS
  envelope. The method was validated by reproducing `floated.mp3`'s recorded 458 ms before trusting it on
  anything new;
- **and rust is the case that made the method worth having.** `rust.mp3` is not one hit: near-silence, a
  decisive crack at ~100 ms, then a clatter of secondary breaks over 230–540 ms. Its whole-clip loudest
  RMS window is at 525 ms and its whole-clip peak sample at 387 ms — **both inside the clatter**. A naive
  "align the peak" would have started the clip early enough to put its opening crack in the middle of
  oxidation, before anything had fractured. The event's onset is the break out of silence; the rest is
  that break's debris, which is exactly what the brief wanted falling over the failure phase;
- **offsets resolve against the ACTIVE schedule**, both of them, per cue. Two of the three clamp at 0
  under reduced motion because those timelines reach their milestone sooner than the clip reaches its
  attack — 10 ms late for rust and 29 ms for the discard, written down rather than hidden (VF-3's
  equivalent miss on `floated.mp3` is 298 ms);
- **multiplicity is a matter of WHERE the cue is fired from.** All three are scheduled in the shell's own
  raisers, which run once per authoritative event. Firing rust from the chip row would have played once
  per corporation — six fleets rusting in one dispatch would be six cracks for one reducer call;
- **Bank: one per genuine break.** The trigger is a `false -> true` crossing of `bankIsBroken`, so a Bank
  that refills and dips again is `true -> true` and never reaches the raiser; the persistent rainbow
  ticket is a state rather than an event and has no cue; nothing sounds at commit or settle;
- **Rust: one per GLOBAL event.** One call above a `corporations` list, never a loop over it. A Gentle
  Rust *marking* is silent for free: `destroyedRustedModels` yields an empty list at a marking, and the
  empty-list guard sits above the cue. The *expiry* that finally destroys them gets one crack;
- **Discard: one per successful action, and deliberately not de-duplicated.** The opposite rule to the
  Bank's: a corporation two over the limit answers twice and two presidents in a queue answer once each,
  and each is a decision somebody made. A refused discard is silent by the same `before !== after`
  identity test the flourish uses (#778). The only limiter is `playVariantCue`'s shared concurrency cap,
  which drops a fourth simultaneous clip rather than a second sequential one (#1041);
- **replay, refresh and remote.** Every raiser is guarded on `replayingHistory` before the cue is
  scheduled — asserted as an ORDER, not just as a presence — so a rebuild that crosses a break, a rust
  and a discard on its way forward is silent, and a refresh into an already-broken Bank has no event to
  raise. A live remote action is a thing that just happened and sounds for every viewer;
- **no new audio infrastructure.** `playVariantCue` for all three: master SFX mute, shared volume,
  concurrency cap, radio ducking, preload cache. `sfxEnabled` alone and no category of its own, which is
  #1457's rule for the presidency cue — these are no more a "turn", "revenue" or "payout" than a
  presidency is. Scheduling reuses the flourish timer list, so an unmount cancels a pending cue;
- **reduced motion changes motion, not audio.** The app's existing policy — VF-3 sounds the float's stamp
  under reduced motion and VF-5 its tile commit — so the cue helper reads the preference only to pick
  which schedule the offset is measured against, and touches nothing else.

**And the rust visual had to change to earn its sound** (section 5's audit, answered). VF-7's failure
phase translates and rotates the whole chip as ONE object and fades it: the fracture is drawn *across* an
intact chip that never divides. The brief's worst case was "two broad pieces that gently fade"; what
shipped was one piece. So at the `fail` beat the chip now gives way along the crack it was just drawn, in
two or three clipped pieces that drift three pixels apart and fade. The same fracture geometry, used a
second time as a partition — `crackPath` draws it, `crackFragments` partitions on it. Not a milestone
moved, nothing under reduced motion, no particles and never more than three pieces.

*Two details of that worth keeping.* The branch has to be **extended to the edge**: `crackPath` draws a
main run edge to edge plus a branch that stops in the interior, which divides the chip into exactly two —
a branch that stops short is a flaw, not a seam. Running it on is also what a cracked thing does when it
finally gives. And a **splinter is not a fragment**: measured over 572 seeds the three-way split tiles the
chip exactly every time, but 30% of seeds leave one piece under 8% of the area, which at 34×24 is a
hairline that reads as a rendering fault. Those break in two instead.

**Untouched.** Gameplay rules, event triggers, flourish schedules (no beat moved), Tutorial behaviour,
replay suppression, reduced-motion semantics, Bank countdown logic, Rust destruction logic, Train Limit
discard logic.

Files: `public/audio/bank-broken.mp3`, `rust.mp3`, `train-discard.mp3` (placed and renamed off their
provider strings); `components/bankBreakFlourish.ts`, `components/trainRustFlourish.ts`,
`components/trainDiscardFlourish.ts` (cue constants, and the rust fragment geometry and stylesheet);
`components/TrainBadges.tsx` (the pieces); `App.tsx` (`scheduleFlourishCue` and three calls).
Tests: `components/flourishAudio.test.ts` (21 cases); `components/trainRustChips.test.tsx` amended, with
the reason recorded in place.

---

## Part C — Open review items (all VF-1)

### C-1 · `PLAYTEST` · Card focus border weight
The focus cue is the card's existing 2px border switching to that corporation's own livery colour. Restrained
by design — the brief ruled out glow, pulsing, scaling and flashing, and said to simplify the border first if
the combination became busy, so there is deliberately no ring or shadow behind it. **Risk:** a pale livery
(ERIE's `#f5cd3a`) against the card's `#f2f0eb` paper may not read as a state change at all. Cheapest fix if
so: a 1px inner ring in the same hue, or darkening the border colour only.

### C-2 · `OWNER DECISION` · Dimming covers the ownership table only
Non-participant rows in the ownership table subdue to 45%. The card **header** (herald, ticker, prices) and the
**Buy/Sell controls** keep full prominence: the header is how a reader identifies which card is acting, and
dimming live controls mid-turn reads as "disabled", which the brief explicitly ruled out. **Open question:**
whether table-only dimming is enough focus on a dense card. Extending it to the header is a one-line change.
*Note the asymmetry:* dimming is table-only, but **staging covers the whole card** (see C-8).

### C-3 · `PLAYTEST` · Takeover length
Ordinary transfer 350 ms; a presidency-changing transaction 730 ms. Inside the brief's band, but a takeover is
the longest single presentation in a stock round and stock rounds are click-heavy.

### C-4 · `PLAYTEST` · The 200 ms resolve point
The transfer's figures land at 200 ms of a 260 ms stage, on the merge. A purchase that overtakes a rival
re-sorts the rows at exactly that instant, so the row glide begins while the chip is still fading. May read as
one settling motion, or as two things happening at once.

### C-5 · `PLAYTEST` · The landing row's ink
A first purchase draws a temporary receiving row showing `--` (the card's own absence glyph, shared with an
unparred price and a corporation that has never run). It exists for ~200 ms and then fills in. **Open:**
whether it wants a quieter ink than an ordinary row so it reads as a destination rather than as a holding of
nothing. No entrance flourish was added, deliberately.

### C-6 · `OWNER DECISION` · Presidency cue has no category of its own
`presidency.mp3` plays through `playVariantCue` under the **master** SFX toggle and volume. The three existing
categories are `turn`, `revenue` and `payouts`; a presidency is none of them, and the ruling was explicit that
this must not add another control. **Revisit only if** playtesters want it separable — that is a deliberate
fourth category, not a bug fix.

### C-7 · `OPEN` · An off-screen card still animates
#1450's screen-space module carried a viewport check; it went with the module. The card-local proxy is now
drawn whether or not the card is scrolled into view — harmless (nobody sees it) but the timers run for
nothing. Low priority; it costs one `getBoundingClientRect` against the viewport to restore if it matters.

### C-8 · `OWNER DECISION` · Staging covers the whole card, including the float badge
The staged overlay is applied by rebinding `company` at the top of the card's `.map`, so *every* reader
downstream picks it up — the ownership rows, the certificate counts, the roster sort, the crown, **and the
float-progress badge**. A buy out of the IPO therefore advances the badge on the transfer beat alongside the
IPO row rather than ahead of it, which is the coherent behaviour. **Nobody has watched the badge do this.**

### C-9 · `PLAYTEST` · Reduced motion
Keeps the border, the dimming, the crown fade, the landing row **and the whole staged progression** — the
figures still advance on the same clock, simply unchased by a chip. Drops the travelling proxies and the row
glide. **Open:** whether that still reads as a transaction to someone using the preference, or as figures
changing on their own.

### C-10 · `OPEN` · The row glide has never been observed
jsdom reports every `offsetTop` as 0, so the FLIP cannot be exercised in a test: the suite asserts that the
roster *order* changes on the right beat, but the transition itself is unverified. It is the single largest
untested surface in VF-1 and the first thing to watch in playtest.

### C-11 · `OWNER DECISION` · A mid-sequence remount replays the whole presentation
The corps tab is conditionally rendered, so switching away and back inside the ~730 ms window unmounts and
remounts the roster. Progress, timers and the audio guard all reset together, so the sequence replays from
`before` with its cue — self-consistent (the reader who just came back sees the crown arrive and hears the
sound that goes with it) rather than a duplicate. Recorded because it looks like a bug in a log.
Audited 2026-09-15: sequence identity is otherwise stable by construction, so no phantom replay or phantom
sound is reachable without a remount.

---

## Part D — Open review items (VF-5)

### D-1 · `PLAYTEST` · Length and beats
1328 ms for the full sequence (850 ms until the 2026-09-16 re-timing, then 1600 ms until #1471 replaced the 512 ms
wash with a 240 ms reveal); a lay missing some parts runs on its own shorter clock (#1470, D-25). Every time is one
entry in `TIMELINE` or `BEAT_MS` (`tileTransition.ts`), in two kinds. **Macro**, fractions of a 1600 ms span:
geometry from 128 ms on a long-tail settle whose last tenth finishes under the reveal (about 1 px at hex size 40,
at most 2.85 px over every currently accepted transition); construction from 200 ms, a rail's front travelling 544 ms (every currently accepted
transition's rail settled by 812 ms, D-22's facings by 1028 ms); slots spreading from the split; the reveal from
1088 ms, with rings closing and merged outlines handing over under it. **Micro**, absolute: the reveal (240 ms), the shake (136 ms from 32 ms), a slot's pulse (187 ms from 320 ms) with its rings
appearing over 85 ms, a gained slot emerging 68 ms in (388 ms) and the split 119 ms in (439 ms), and a rail
portion's eruption (68 ms). A full lay now takes a second and a half of an operating turn: it may drag, or may be the
one thing on the board worth watching — judge it with D-24's audio attached. Tune in those tables and nowhere
else.

### D-2 · `RESOLVED` (superseded by #1471) · The foundation colour
Was: a new lay on open ground built on `#c4bfb2` (rim `#85806f`) before its tier washed in. Gone with the wash: a
new lay builds over its own washed proposal, and the commit front resolves it (D-26, D-28).

### D-3 · `RESOLVED` (VF-5 revision, #1469) · Construction in sections
Was: new rail went down as a growing stroke in quick eased lengths (about 0.17 hex units per section), at full
opacity and the board's pen, with nothing erupting. Replaced by the travelling construction wave, whose open
judgement is D-23.

### D-4 · `PLAYTEST` · Tension before a city changes
A city gaining capacity or merging shakes along its destination axis before it moves: 0.014 hex units (under a
pixel at the default size), 1.5 cycles in an absolute 136 ms from 32 ms. Close to the brief's line on shake; set
the amplitude to zero if it reads as jitter.

### D-5 · `PLAYTEST` · The ring pinch
While slots divide or gather, their rings are drawn as one union outline — circles pinching apart rather than
crossing — and close back into whole circles as the city settles. Seen in filmstrips, never at board scale:
division, or a rendering glitch?

### D-6 · `PLAYTEST` · Busy merges
Mid-merge frames of the genuine merges (#54 → #883, double towns into one — D-21) stretch two outlines toward
each other. Since #1473 merging cities reach for each other across the gaps between them at a city's full width —
New York's two cities are one shape from 616 ms, before the slots the merged city adds show at a quarter of their
strength (680 ms) — where they used to grow a neck out of a line, which read as a black rail between two cities
until about 600 ms. Town merges have no neck and are unchanged. **Risk:** busy at small hex sizes. **Watch:** whether
the reaching reads as city rather than as a blob, and whether the merge still reads as one city forming over its
planned shape (D-27).

### D-7 · `PLAYTEST` · Tokens in a reorganising city
Since #1472 a token gathers with its slot. The two tokens of a full two-slot city converge as the slots gather,
overlap — centres within one token radius — from about 372 ms until 750–840 ms, closest at a sixth to a third of a
radius, and part with the reorganisation, each for its own authoritative slot; the gained slot stays empty. The
overlap is intended and never offset. The token drawn on top is the later one in the token pass's roster order, in
every frame. **Watch:** whether 400 ms of one token covering another reads as the pieces gathering or as a token
disappearing; whether a token crossing its neighbour on the way out, where authority seats them the other way round,
reads cleanly. Was (#1466): a token swung about its city's anchor from its old slot to its new one, apart from the
rings. A token that arrives in the same update as the tile did not stand on the hex before, so it is drawn at its
final slot from the first frame, over a city still changing — never invented, never moved.

### D-8 · `OWNER DECISION` · Reduced motion is a fade
240 ms, no front, no tension, division or morph. A confirmed proposal fades from washed to committed where it stands
(#1471): nothing moves, its tokens, reservation markers and value hold still, and no planned place is shown (#1472 and
#1473 left it so). A lay nobody proposed here crossfades from the old tile as before: fills and rails crossfade;
stations, tokens and, since #1473, reservation markers swap at the midpoint, because two see-through stations would be
worse than a swap. Sound (#1474): the commit's cue alone, on the fade's first frame — nothing is built or split to
hear, and #1060's rule keeps a reader who asked for less motion hearing the event. **Open:** whether 240 ms of mixed
tier colour is the
"muddy third colour" #167 warned about.

### D-9 · `OWNER DECISION` · What plays, and what snaps
Plays: exactly one hex whose presented tile changes, from nothing or from a tile, to a tile no lower in tier.
Snaps: a removal (an undo; a refused lay's ghost released), a downgrade, a re-facing, and several hexes changing
at once (a replay jump, a reconnection, a room's first grid). **Watch:** a replay step, a reconnection or a first
grid that changes exactly one hex does play.

### D-10 · `OWNER DECISION` · Supersession is a snap
A hex whose picture changes again mid-flourish drops the running transition — the hex jumps to the intermediate
tile — and, if the new change plays, a fresh flourish starts from that tile. No queue and no chaining.

### D-11 · `PLAYTEST` · The room round trip
The flourish starts on the held ghost at the confirm, from the proposal it was (#1471). Its value was already on
the board's own slot, washed, and commits with the front; if the grid returns after the flourish ends, the held
ghost is drawn by the tile pass exactly as the laid tile will be, so nothing shifts when the flourish ends or when
the grid lands (the ghost's fixed-corner revenue display, #486, went with the ghost pass). A refused lay is not withdrawn by the room: the flourish plays in full on the sent picture, and the
hex returns to its old tile when the ghost's four-second clock releases it (see D-20 for a late arrival).

### D-12 · `OPEN` · What switches on the first frame
A proposal counts as laid for every printed pass (#1471), so on a confirmed proposal nothing switches at the
confirm but the rim's dashes and the lay's moving parts. A lay nobody proposed here counts as laid from its first
frame: its printed value fades out as the proposal arrives, and the frame redraws the printed track, stations and
dits it starts from, but the printed terrain icon, the printed name label and the terrain-cost badge disappear on
the first frame rather than fading.

### D-13 · `OPEN` · Overlays are not staged
Route overlays, the focus veil and hover highlights draw from authoritative state over a hex mid-flourish, so a
route could be drawn along rail still under construction. Routes are planned after the lay, so this should be
rare.

### D-14 · `PLAYTEST` · Reservation markers ride with their city
Since #1473 a home reservation marker is a piece in its city, as a token is (D-32), on every lay — a confirmed
proposal's too. Its city is read from where the board draws it — the city's centre or one of its slots — and it rides
that city's own choreography: a marker on a city's centre stays on the centre through a split or a reorganisation,
following no branch, and travels with a migrating or merging city. It has no planned place — it is already drawn as a
faded token — so while a tile is being chosen a marker the confirm will move is left out of the proposal, and from the
confirm the real marker rides in from where it stood; a marker the lay does not move stays as it was. On an OO home
(ERIE, PMQ) the two markers on the printed circles converge on the one city a tile gives them: the one whose circle
becomes that city rides it, and the other — like any marker whose old city does not become its new one — moves
straight to its place, as before (D-35). Swept over every accepted transition on a home hex, remote and confirmed
(3,466 markers): every start and end exact; the 2,710 that ride a seat inside their city's drawn shapes in every
sampled frame (at least 4.4 px inside at hex size 40); at most 2.8 px left to travel when the commit starts.
**Watch:** whether a marker missing from the proposal while the tile is being chosen reads as "this reservation
moves" or as a reservation gone.

### D-15 · `RESOLVED` (withdrawn by the VF-5 fixed-OO correction) · A city that emerges
Withdrawn. The facings it described — #59 → #64 with both #59 cities' rails in one brown city and the other brown
city new — are rules-illegal under fixed OO (D-22), so there is no intended emerging city to playtest, and among
the 67,308 currently accepted transitions nothing else produces one. The description keeps its emerge event
(it describes whatever pair it is handed); nothing was added for #59.

### D-16 · `OPEN` · The hand-over at pixel level
First and last frames stroke every line exactly once (tested) and match the tile pass to rasterisation noise:
curved rail is drawn as polylines (within 0.04 px of the curve at hex size 64) and a pill's outline as a fattened
stroke rather than a capsule path. One difference is by design: rail carried over from a green crossing tile
(#16, #19, #20) is layered the way the brown tile layers it from the first frame — the same rail on top in all 48
carried crossings, but drawn with the brown tile's overpass clip, whose faint edge the green tile does not have.
If a flicker is ever seen as a flourish starts or ends, look here first. Since #1471 the committed last frame is
#1470's to within one intensity level (the old tier no longer sits under the destination's fill), a confirmed
proposal's first frame differs from the proposal only inside its moving parts' footprint, and a lay nobody
proposed here starts on #1470's first frame (checked on every 7th currently accepted transition).

### D-17 · `OPEN` · Whole-board repaint while a flourish runs
The frame clock (#463's pattern) repaints the whole board canvas every animation frame while any transition runs
— at most 1328 ms per lay (1600 ms before #1471, 850 ms before the re-timing). A proposal adds nothing: it is
repainted only when the board is. Unmeasured on low-end devices.

### D-18 · `OPEN` · Rules cross-reference: New York's four-slot city
The brief described "two two-station cities → one four-station city". The four-slot #883 (Brown) is offered by
the sandbox filter over the green #54 — two one-slot cities — while #62 (Brown, two two-slot cities) → #883,
the upgrade #1315 plans token moves for in `utils/nyMerge.test.ts`, is not offered, being the same tier. Both
play as one merge; which one is legal belongs to rules hardening.

### D-19 · `RESOLVED` (Stage 9.2, `17616c8`) · Rules cross-reference: printed track severed on the expanded boards
On the expanded and LPF boards the sandbox filter offers #53 (and #592 on expanded) on Baltimore (I15) at facings
that do not carry the printed track, because its path-preservation rule runs only over a laid tile. The flourish
fades the severed printed rail, so nothing is left behind. For `RULES_HARDENING_BACKLOG.md` triage; nothing was
changed here.

**RESOLVED by Stage 9.2 — `17616c8359765a029d170eca82e7b1698c91222c`, "Stage 9.2: enforce board topology
authority".** The finding above was exactly right, and it was a rules-engine defect rather than a flourish one:
Stage 9.1 filed the same cause independently as **F-2 / S9-10** ("printed board topology is invisible to
`preservesRouting`, which is gated on the laid tile"), and Stage 9.2 made board-printed topology authoritative via
`priorTopologyAt` (design note #1621). **VF-5 exposed and recorded the defect; the rules engine fixed it. Nothing
in VF-5 caused it and nothing in VF-5 was needed to resolve it.**

What changed on the board: Plus/LPF Baltimore **I15** now resolves as `source = landmark`, exits `{0, 4}`,
segments `[[0,4]]`, and the facings that severed that printed rail are refused.

| | legal facings after Stage 9.2 |
|---|---|
| Plus/LPF **I15 → #53** | **0, 2, 4** (1, 3, 5 refused — they delete both printed exits and the whole `(0,4)` rail) |
| Plus **I15 → #592** | **0, 2, 4** — same parity |
| **E23 → #53 / #592** | **1, 3, 5**, unchanged by Stage 9.2 (the rim test already refused the wrong parity there) |

**The location stays upgradeable — only the track-cutting orientations disappeared.** There is no rules-engine
regression, and no new gameplay defect is filed.

**Consequence for the VF-5 test `resolves an unexpected pair to the destination with no orphaned stroke`.** That
fixture selects a facing by `describeTransition(candidate).removed > 0`, and on I15 the only such facings were the
illegal ones, so it now throws. **The fixture was stale and needed repair — and the repair was NOT "find
another legal transition with `removed > 0`."** An exhaustive post-commit sweep of the legal transition graph on
all three boards found **28,438 legal transitions — standard 6,859, plus 11,313, LPF 10,266 — of which 1,405 have
`reconfigured > 0` and ZERO have `removed > 0`.** That is structural rather than incidental: a legal lay or
upgrade must preserve every source segment, so every source piece finds a destination match, and `removed` is
precisely the renderer's signature of *deleted* rail. **`removed > 0` is not reachable from a legal game
transition under the current transition model.**

So the visual owner should pick one of two strategies, and the choice is theirs — **nothing in VF-5 was changed by
the Stage-9.2 work**:

- **A · legal gameplay / no-orphan test.** Keep testing that the flourish lands cleanly on the destination with no
  orphaned stroke, over a genuinely legal transition with `reconfigured > 0`, optionally `added > 0`, and
  `removed === 0`. **Plus `I15 → #53@0` is a suitable candidate and keeps the fixture's shape** — same hex, same
  tile, measured `reconfigured = 2`, `added = 1`, `removed = 0`. 1,405 legal candidates exist in all.
- **B · synthetic renderer-only removal test.** If the `removed` branch still deserves unit coverage in its own
  right, build the plan by hand, mark it renderer-only / non-gameplay, and do **not** obtain it by asking the
  rules engine for a legal tile lay.

The dependency direction this keeps straight is the one D-21 already states of its own corpus — *"accepted is not
a claim of rules legality"*: rules legality → legal transition → visual flourish, never a visual test's need →
weaker rules.

**Carried out on the VF-5 side, 2026-09-18 — both strategies, test-only.** **A:** the fixture is now the legal Plus
`I15 → #53@0` (asserted `persistent 0, reconfigured 2, added 1, removed 0`; the facing is picked by the classes, not by
a tile id or a facing number), renamed *lands a legal re-pairing of track on the destination with no orphaned stroke* —
the same no-orphan claim over the strongest legal shape there is. **B:** the renderer's `removed` arm is held by a
hand-built plan (#8@0 → #9@0: a curve replaced by a straight, `added 1, removed 1`), labelled in the test as synthetic,
renderer-only, non-gameplay and not produced by legal tile placement, and never obtained from the placement filter. No
legality file was modified, no production legality behaviour changed, and no VF-5 animation semantics changed.
**D-19 is closed; nothing further is owed by either side.**

### D-20 · `RESOLVED` (VF-5 structural audit, #1468) · A lay could play twice
Found by the audit of 2026-09-15. The flourish starts on the held ghost. If the shell drops that ghost before the
grid lands the lay — its four-second clock on a slow round trip, or any board click or new preview in the
meantime, because the preview is one slot — the hex showed its old tile and the late arrival played the whole
flourish again. Now a hex whose ghost left without its tile awaits that tile, and when the grid alone lands it,
it simply appears. The wait is forgotten on any other change at that hex, on any grid change elsewhere (a refused
lay never arrives) and on a board change; a new ghost is a new send and plays. Pinned by four behavioural cases
in `tileTransitionStaging.test.ts`. **Still as #1145 left it:** a dropped ghost shows the old tile until the lay
lands.

### D-21 · `OPEN` · Rail-less printed centres pair by position, and some facings tie
Centres with rails correspond uniquely — across the 67,308 currently accepted transitions (what the placement
filter's walk accepts on the three tables; accepted is not a claim of rules legality) the audit found no tie and
no split, and every anchored token's game destination matched the flourish. **Merge evidence, re-run without
D-22.** A new centre has two sources in 642 of those transitions. 386 are genuine merges, each standing on its
own geometry: the double towns #1, #55 and #633 → #88, #2, #56 and #632 → #87, and #69, #630 and #631 → #204 (384,
at B20, F20, G7 and G17 on the expanded and LPF boards) and New York #54 → #883 (2, G19 on both boards). In every
one, each old centre's rails reach only edges the new centre's rails reach, together exactly those edges; the
centres of that kind go from two to one; every rail is reconfigured and none added or removed; and for New York
the game's token planner lands either old city's token in the merged city. The other 256 are D-22's facings,
which are not merges and are not evidence. Centres without rails (the
printed OO circles and double-town dots) pair nearest first, and at symmetric facings the candidate distances are
equal up to the catalog's six-decimal rounding (differences of 3×10⁻⁸ to 2×10⁻⁷ unit): printed OO → #59 at
facings 0 and 3; printed double town → #55 at 2 and 5; and in the 18XX+ tray printed OO → #626 at 2 and 5 and
printed double town → #633 at 0 and 3. Deterministic, and the two answers are mirror images, so nothing looks
wrong. **The token half:** a token on a printed OO circle has no rails, so the game lets the president choose its
city (#824, #878); it rides to that city whatever the circles do, and can leave the circle it stood in.
Presentation only; nothing changed.

### D-22 · `OPEN` · Rules cross-reference: #59 → brown OO facings that break fixed OO
This implementation plays fixed OO; the optional Variable OO Cities rule is not used and was never requested.
Old #59's two cities are distinct single-station cities on disconnected track, and each brown OO upgrade is
again two distinct single-station cities, so an upgrade carries each #59 city into its own brown city. The
placement filter currently accepts 256 transitions that do not: #59 → #64, #65 and #67 (48 each: D10, E5, E11
and H18 on the standard board, E5, E11 and H18 on the expanded and LPF boards) and #59 → #35 and #36 (56 each:
E5, E11 and H18 on the expanded and LPF boards), at facings that put both #59 cities' rails into ONE brown city
and leave the other brown city with no predecessor. **These are rules-illegal facings, for rules hardening; no
legality was changed here.** They are not intended mergers: the flourish has no #59-specific rule, and they are
not evidence for the merge classifier (D-21). Handed such a pair, the correspondence describes what its geometry
reads — one brown city with both sources, one emerging — and it was not altered to describe an invalid
transition differently. The game's token planner accepts the same facings (a token from either #59 city lands in
the joined city; tokens in both are refused for capacity), which belongs to the same rules question.

### D-23 · `PLAYTEST` · The construction wave
New rail is revealed by a front travelling from its origin along the rail's own geometry. Behind the front each
portion — about one rail width, never fewer than six to a rail — fades in over the first 35% of its settle, is
widest (1.15× the pen, outline included) at 30%, and eases back to exactly the pen; settled portions stay. The
settle is an absolute 68 ms; the front travels a rail in 544 ms, every rail of a lay in the same time, so in one
lay a short spur's front moves more slowly than a long straight's. The portion counts were not raised when the
clock grew, so on rails under about one hex unit the front now rests between portions: up to 23 ms on a city spoke
(7 portions) and 41 ms on the shortest rails (6); rails of 9 portions or more stay unbroken. The constants are
`CONSTRUCTION_WAVE`, `BEAT_MS.portionSettle` and `TIMELINE.constructTravel`: starting points, not tuned.
**Watch:** whether the swell reads at board scale (at hex size 40 it is under half a pixel each side); whether the
fading, wider tip reads as eruption or as a rendering fault; whether the rests on short rails read as rail being
laid or as stutter; whether equal travel for rails of different lengths looks mismatched where branches leave one
city (to be compared later with equal propagation speed); forks and overpasses while a portion erupts there (each
portion is drawn in its destination rail's layer and cuts its own overpass gap — checked in filmstrips and
structurally, never watched).

### D-24 · `PLAYTEST` · Tile-transition audio
Wired by #1474 to the plan's semantic beats (`plan.beats`, #1470), never to timers of its own, with the clips in
`public/audio`, their dead leading material trimmed after #1474 (D-36): `track.mp3` at `constructionStart` — the first
genuinely new rail begins (200 ms; 416 ms on D-22's facings); `mutation.mp3` at `stationEmergence` — new slots begin to
emerge (a 1 → 2 or 1 → 3 city's split, 439 ms; a 2 → 3 city's gained slot, 388 ms; a merge's added slots, 439 ms);
`upgrade.mp3` at `revealStart` — the commit front begins (1088 ms with a mutation or geometry, 812 ms for rail alone,
128 ms for a commit alone, 0 ms under reduced motion). Each sounds once per transition, on the first frame at or past
its beat; tails run past the visual end, and the visuals are not lengthened for them. Decoded, the clips last 1.20 s,
0.23 s and 0.84 s, the last two ending in an 8 ms fade to digital zero: `track.mp3` sounds from its first millisecond;
`mutation.mp3` rises above -40 dBFS within 7 ms, hits by 27 ms and peaks at 44 ms; `upgrade.mp3`'s riser is above
-40 dBFS from 10 ms, its brightest hit peaks at 130 ms — about the middle of the sweep — and its loudest 10 ms start at
184 ms, in the sweep's last quarter. In a full sequence the mutation clip has ended by about 700 ms, so only the rail
clip is still sounding when the commit's cue starts (D-39). **Watch:** whether the rail cue's own rhythm, which is not
synchronised to the construction wave's portions, reads as construction; whether the mutation cue's hit, about 27 ms
into the split, reads as the split; whether the commit cue's riser and hits read as the front's own sweep, on a commit
alone and under reduced motion's fade too; the three against the radio and against each other.

### D-25 · `PLAYTEST` · How long each kind of lay takes
Derived, not tabled (#1470), and 272 ms shorter since #1471 wherever a wash ended a lay. Over the 67,308 currently
accepted transitions: rail alone 59,901 at 1052 ms; a commit alone 128 at 368 ms (a 128 ms hold, then the 240 ms
reveal); everything with a station mutation or geometry at 1328 ms — rail with geometry 3,838, rail with a mutation
2,287, a mutation alone 747, geometry alone 384, and 23 with both. **Watch:** whether 128 ms on a confirmed
proposal reads as a beat before the commit or as lag; whether a mutation or migration without new rail still has
a quiet stretch before its reveal — its slots or centres keep settling until about 1000 ms (the last frame moving
more than 0.1 px at hex size 40 measured at 960–1040 ms for mutations and about 850 ms for two towns fusing), so
the lever there would be their spreading, a visual change not made here.

### D-26 · `PLAYTEST` · The proposal's wash
The tile being chosen is the whole destination tile at its facing with every printed colour — fill, rim, rail ink,
station ink, town dots — mixed 45% toward `#e8e4da` (`PROVISIONAL`); rail outlines and station faces stay paper
white; the rim is dashed (#1145) and the hex opaque (#167); its value is the board's own badge at 60%. Tokens and
reservation markers sit above the tile and are never washed; a token the lay will move is shown at its planned place
at 40% instead, and a reservation marker the lay will move is left out (D-34, D-14). **Watch:** whether it reads as
provisional at a glance and still lets a player check rail, city positions, slots and the value; whether the pale
green or pale brown is mistaken for a different tier; whether the radial selector's full-colour candidates beside it
confuse which one is the board.

### D-27 · `PLAYTEST` · Planned shapes under moving parts
From the confirm, what the lay changes is drawn in full ink over the proposal's planned copy: added rail erupts
over its washed rail; reconfigured rail morphs from its old geometry toward its washed copy; a changing centre
plays from its old drawing while its planned shape recedes to 35% over 128 ms. **Watch:** whether a 1 → 2 split or
a 2 → 3 reorganisation still reads as one city dividing (the receded planned rings sit under the dividing ones);
whether a moving city (Baltimore, Boston, New York's stubs, the OO spurs) reads as migrating into its planned place
rather than as two cities; whether the receded planned centre, drawn over the rails inside it, looks like a veil on
rail still moving; whether merges (D-6) get busier with the planned shape under them. While the tile is being chosen
a token the lay moves is shown faint at its planned place (D-34); from the confirm the real token sits in the old
drawing's slot and travels into that planned place (#1472, D-32).

### D-28 · `PLAYTEST` · The commit reveal
A front crosses the hex west to east in 240 ms (`BEAT_MS.reveal`, smoothstep): committed behind it, provisional
ahead of it. Since #1473 it leans 20° off vertical with its top ahead of its bottom (`REVEAL_SLANT`), so the commit
sweeps left to right and top to bottom, and its edge is a light hairline (1% of the hex size, at least 0.5 px, 85%)
with a faint shade (20%) on its committed side, drawn on the tile's fill — under the rim, rails, stations, value
badges, B/NY/OO/TO markers, terrain costs and every other pass; nothing rotates, blurs, glows or bounces. Tokens and
reservation markers are drawn over it, never washed, and finish the last of their travel under it with their slots
(D-14, D-32); a token's planned place fades as the commit settles the token on it (D-34). The geometry's last tenth
settles under it (about 1 px, at most 2.85 px, at hex size 40). **Watch:** speed, direction and lean; whether the
hairline reads at all under busy art, and as a commit rather than a scan line; whether 240 ms is noticed at board
scale on a green-to-brown upgrade whose tiers are close in value; whether a value badge committing as the front
passes it reads cleanly.

### D-29 · `OWNER DECISION` · A lay nobody proposed here shows its proposal first
Another seat's lay, a replay step, or any lay this board did not preview starts on the old tile, becomes the washed
proposal over 128 ms — its persistent rail and unchanged centres wash too — and then plays the same sequence, so
every lay on every screen ends with the same commit. The alternative would be two different sequences for the same
lay depending on who laid it. Its tokens have no planned place (#1474): that proposal answers no choice made on this
board, so each token rides in from its seat with nothing waiting for it (D-34); it sounds the same cues as a confirmed
proposal (D-24).

### D-30 · `OPEN` · Clip antialiasing while the front crosses
Each side of the front is the same drawing under a clip, so nothing is stroked twice. A stroke clipped as it is
drawn antialiases its clipped edge over whatever lies beneath it, and #1471's edge line covered the seam that left.
Since #1473 the edge runs under the art, so the seam is closed instead: the committed side's clip reaches a pixel and
a half past the front; a fill hidden under an opaque one is not drawn; and each side's art — rail outlines under
inks, a city's ink under its white — is painted whole into a scratch layer and laid on under its clip, so a finished
layer's edge meets only the other side's finished layer (where no scratch canvas can be had, each side is clipped as
it draws, as before). In harness zooms the faint line of lower strokes across stations and rails is gone. The value
badge is still drawn clipped per side — a disc and a figure — so a faint seam across it, for the frames the front
crosses it, is possible; if one is seen, look here.

### D-31 · `OWNER DECISION` · The proposal replaced #822's ghost pass
The preview is drawn in the tile pass, not over the finished board, so the passes a laid tile sits under now draw
over a proposal too: impassable borders, B/NY/OO/TO restriction badges, private reservation badges, and the focus
veil wherever it dims that hex (never while the selector is open, when the hex is the sole focus); the value badge
takes the board's slot rules rather than the ghost's fixed corner (#486); a printed
value that also shows on a laid tile shows on its proposal. Tokens still draw last (#222, #822). An unknown tile id
falls back to the tile pass's placeholder, undashed.

### D-32 · `PLAYTEST` · Tokens are pieces seated in their stations
Every token rides the slot that holds it, from the place it stood on the tile the hex showed to the place
authoritative state gives it (#1472). **One slot becoming more:** it sits in the lone slot through the shake and
the pulse and leaves with the split, along the branch that ends at its own slot. **Several becoming another
number:** D-7. **A lone circle that moves** (Baltimore, Boston, New York's stubs, the OO spurs): it sits in the circle
and arrives with it, never at the destination first. **A merge** (#54 → #883): each token travels with its own
city's slot, the two stay distinct pieces, and they settle into the merged city's slots in company order. **A city
that does not change:** nothing moves the token — except where the board numbers the same slots the other way round
on the two tiles (#15 or #619 → #63, #810 → #882 at some facings): a lay nobody proposed here swings it about the
city's centre into its slot, finished before the commit, and a confirmed proposal leaves it where the proposal drew
it. **At the confirm** the real token appears in its seat in the city's old drawing — in the frame that drawing
reappears over the planned one (D-27) — while its planned place stays where the proposal showed it (D-34), and it
rides into that place. **Under the
commit** the last of its travel settles with its slots: at most 1.24 px for a capacity change, 2.85 px for a
migration and 3.63 px for a merge, at hex size 40. **Where no seat can be read** — the old city is not a source of
the new one, a token on a printed OO circle with no recorded city (D-21), or a token not drawn in the slot its city
index names (printed New York draws every token in its first circle, #221) — it moves with its two cities' anchors,
as #1466 did. Swept over every currently accepted transition with a city, remote and confirmed, with every
occupancy the board's slot order allows (30,222 tokens): every start and end exact, every sampled frame inside the
city's drawn station shapes (at least 1.4 px inside at hex size 40), no two tokens ending in one slot, every full
2 → 3 gather overlapping. **Watch:** whether the confirm reads as a planned place becoming a piece on its way there;
whether tokens passing over a receded planned shape read as moving above it.

### D-33 · `RESOLVED` (#1473) · A confirmed proposal's reservation markers held still
Was: #1472 seated corporation tokens only, and a confirmed proposal's reservation markers held where the proposal
drew them while their city moved in beneath them. Since #1473 every reservation marker rides its city, reading its
city from where the board draws it rather than from an index it does not carry (D-14); an OO home's markers are D-35.

### D-34 · `PLAYTEST` · A token's planned place
While a tile is being chosen, a token the lay will move — one `pieceMoves` finds further than 0.02 of the hex from its
place anywhere along the ride the confirm would play — is drawn only at its planned place, at 40%
(`PROVISIONAL.pieceAlpha`), under every piece. From the confirm that planned place stays, whole from the first frame,
while the real, full-strength token rides in from its old seat; it fades over the commit's 240 ms and is gone exactly
as the token settles on it (`pieceTargetPresence`). **Only a lay this board proposed has one (#1474).** Another seat's
lay, a replay step, or any lay nobody proposed here rides its tokens in from their seats and settles them into their
places with nothing waiting there; #1473 had shown a planned place on those too, arriving with that lay's proposal
over the lead. A token the lay does not move — in a city that does not change, or reseated by the board's own slot
numbering on a confirmed proposal, which already drew it there — has no planned place and is drawn as before: over
every occupancy of every accepted transition, 12,804 of 15,111 tokens on a confirmed proposal have one and 2,307 do
not. Reduced motion shows none. Only corporation tokens have one (D-14). **Watch:** whether 40% reads as clearly
subordinate to a real token over a washed proposal; whether a planned place half covered by a token still gathering or
travelling reads as a target or as a second token.

### D-35 · `OPEN` · An OO home's reservation has no city to ride
The board draws an OO home's reservation (ERIE at E11, PMQ at E5) in a laid tile's second city (#43, #724a) and on
both printed circles before any tile (#1283): a place, not a city, because the president chooses the circle. Where
the new tile's second city is not what the old second city becomes — the brown OO facings over #59 (#64, #65, #66,
#67, #68, #984, and D-22's joins), #64/#66/#67/#984 → #167, and one of the two printed markers going to #59 or #626 —
the marker has no seat to ride and moves straight across the hex (0.4 to 1 hex unit) while the cities migrate, as it
did before #1473 (756 of 3,466 markers). Nothing pairs it with a city instead: which city a reservation marks is the
board's placement rule, unchanged. **Watch:** whether a reservation crossing the hex reads as wrong; the lever would
be that placement rule, which is not presentation's to change.

### D-36 · `RESOLVED` (asset trim, 2026-09-16) · `mutation.mp3` was silent for its first 1.37 s
Was: as supplied, the clip was 1,337 ms of digital silence and a lead-in below -44 dBFS, first above -40 dBFS at
1,376 ms, so played at `stationEmergence` it was heard about 1.8 s into a 1.33 s transition, after the tile had
finished. The file was trimmed — 1,369.9 ms removed, nothing moved in code — and it now rises above -40 dBFS within
7 ms of `stationEmergence` and hits by 27 ms. `upgrade.mp3`'s 93 ms of near-silent lead-in went in the same pass
(D-24).

### D-37 · `OWNER DECISION` · A station change the plan gives no moment is silent
`mutation.mp3` rides `stationEmergence` and nothing else. Over the currently accepted transitions these station changes
have no such beat, and sound no mutation: a city losing a slot (#592 → #61's 2 → 1, 24 transitions — `stationMutation`
is set, but nothing in the plan names when the slot closes); two towns fusing (384); a city re-laid with the same slots
(#14 → #63 and the like, 2,056); D-22's rules-illegal #59 joins (256, a merge beside an emerging city); and, outside
that set, New York's #62 → #883, four slots merging into four. A migration, a city appearing and rail are not station
mutations. Giving any of them a beat is a change to the description, not to the audio.

### D-38 · `OWNER DECISION` · The board reads a mirror of the master switch
`playVariantCue` takes the switch as an argument, and only the shell holds it (#1075); the board is handed no sound
settings, and #1474 left the shell unedited. So `audio.ts` keeps a mirror of the switch — as it already keeps the level
(#1074) — written by `AudioControls`, the one control that flips it (#1102), and read by the board when a cue is due.
**Contract:** anything that ever flips the switch another way (a shortcut, a saved setting) must write the mirror too,
or the board would sound while everything else is silent. The shell could instead hand the board its switch, or its own
cue handler (#1062's split), when it is next open for edits. The tile cues ride the master switch alone and add no
category, as the presidency cue does (C-6).

### D-40 · `PLAYTEST` · The reconfiguration's head start, and what the track cue now covers
`RECONFIGURE_ESTABLISHED` is a quarter of the geometry settle: 433 ms in a reconfiguring transition, a 305 ms head
start over the 128 ms the existing geometry starts moving at, chosen as the smallest stagger that reads as "move and
reform first, then build outward" and deliberately not tuned. **Watch:** whether a quarter is enough on a small
migration (Baltimore's city travels 9.3 px at hex size 40, so it has moved about 1.7 px when the first rail erupts) and
not too much on a large one (the printed OO circles travel 32 px); whether the track cue reads as one continuous act of
railroad work when it starts 305 ms before the eruption; and whether a reconfiguration with no added rail — a town
fusion, New York's merge — wants the same cue at all. The threshold below which a reconfigured rail is "redrawn" rather
than reformed is half a rail width; the near-tolerance facings (#59 → #67/#68, 1.6–2.6 px) sit on either side of it.

### D-39 · `PLAYTEST` · Three cues against a three-clip cap
The helper plays at most three capped clips at once (#1041). Since the asset trim, the mutation clip ends 231–264 ms
after it starts — by about 700 ms in a full sequence — so when the commit's cue starts at 1088 ms only the rail clip is
still sounding (until about 1400–1424 ms), and the commit takes the second place; before the trim the mutation clip was
sounding too, and the commit took the third. A tile cue is now dropped only when two other capped cues are sounding at
its moment — a variant flavour cue, the dividend register, the treasury whoosh — or a second lay's cues follow close
behind. The cap is unchanged and the tile cues are not `uncapped`. **Watch:** a commit cue missing in a busy Operating
Round.

---

## Part E — Open review items (VF-3)

### E-1 · `PLAYTEST` · The translate/scale/flip is unmeasured by any test
`corporationCardFloatFocus.test.tsx` runs in jsdom, where `getBoundingClientRect` reports every rect as
`{0,0,0,0}` — so `useFloatCardTarget` takes its A-3 fallback (`null`) in every single test, and what the
suite actually exercises is that fallback, never the measured translate/scale/flip path. This is C-10's exact
shape one flourish over: the single largest untested surface in this batch, and the first thing to watch in
playtest. **Watch specifically:** whether the card reliably measures a non-zero rect in the real browser (it
should — nothing here differs from `useTransferProxyGeometry`'s already-proven approach), and whether the
translate distance, `FLOAT_SCALE` (1.5) and the width-clamp read right on an actual Stock Round tab.

### E-2 · `PLAYTEST` · Four playtest variables, none watched yet
`FLOAT_SCALE` (1.5), `PRE_FLOAT_LIVERY_SATURATION` (0.5), `FLOAT_STAMP_ROTATION_DEG` (-18°) and the stamp's
offset nudge are all eyeballed defaults, recorded as playtest variables in `corporationFloatFocus.ts` per the
brief's own instruction not to over-tune before a look. **Watch:** whether 1.5x reads as "come forward to
centre stage" without feeling oversized against the roster grid at typical window widths; whether 0.5
saturation is enough to read as dormant against every one of the ten liveries at once, not only ERIE's
yellow and NYC's near-black checked by eye against `CORPORATION_LIVERY_COLORS`.

### E-3 · `OWNER DECISION` · The centring target is the roster grid, not the viewport or the whole panel
Per the approved centring target: `floatGridRef` is attached to `.rosterGrid` (the card grid itself), not
`window` (would need geometry outside this component's zoomed subtree and viewport units the brief asked to
avoid) and not the whole `StockRoundPanel` root (would pull the target up toward the header row and closer to
the sticky action dock several stacking contexts up). The roster grid is the smallest container that reads as
"the Stock Round's own centre" and keeps the target inside the same subtree the card measures itself against.

### E-4 · `OWNER DECISION` · VF-1 and VF-3 compose rather than choose one
The VF-1/VF-3 cross-reference (above, under VF-1) is resolved by composition, not by picking a winner: a
transfer focus and a float focus on the same `company_id` are independent hooks, and the rendered `company`
is a three-way spread (`committed`, `staged`, the float override) rather than one flourish suppressing the
other. **Nobody has watched the two run on the same card at once** — a purchase that both changes hands and
crosses 60% would show the ownership-transfer border/proxy and the float lift/stamp/flip simultaneously.
Recorded so a busy-looking card in that exact moment is read as this deliberate choice, not as a bug.

### E-5 · `OPEN` · The stacking-context claim is reasoned, not screenshotted
The report accompanying this batch reasons from the CSS spec (a `transform`-bearing element opens its own
stacking context; the sticky action dock's `zIndex: 50` lives in a separate branch of the tree with no
intervening ancestor `z-index`) that the lifted card can never paint over the sticky header without a
screenshot confirming it in a live browser. **Watch:** the lifted card at the top of a scrolled Stock Round
tab, to confirm it settles behind the sticky dock rather than over it.

### E-6 · `OPEN` · Off-screen/inactive-tab cost, same shape as C-7
The float timers and the geometry measurement run whether or not the "corps" tab is the active main tab or
the card is scrolled into view — `useFloatCardTarget`'s early return only catches a genuinely unmounted
`cardRef`/`floatGridRef`, not an inactive-but-mounted one. Harmless (nobody sees it, and the A-3 fallback
still degrades cleanly if the rects come back zero-sized on a `display: none` ancestor), but, as C-7 already
notes for VF-1's own proxy, the timers run for nothing. Low priority.

## Part F — Open review items (VF-2)

### F-1 · `PLAYTEST` · Signal speed and pulse duration are first-guess numbers, unwatched
`ROUTE_SIGNAL_SPEED_UNITS_PER_SEC` (3.2) and `ROUTE_SIGNAL_PULSE_DURATION_SEC` (0.35s) are a first coherent
guess (design notes 5, 28 in `HexGridRenderer.tsx`), deliberately not hand-tuned further per the brief's own
instruction, and unchanged by either 2026-09-21 badge-reaction redesign. **Watch:** whether a short route
(1–2 hexes) reads as a pulse rather than a blink, whether a long route (8+ hexes) still feels lively rather
than glacial at the same shared speed, and — now that `ROUTE_SIGNAL_PULSE_DURATION_SEC` is purely a
bookkeeping window around the scale-only pop rather than a visual fade duration in its own right (see the
VF-2 finalize pass above, and F-8 below for the pop's own timing) — whether it still needs independent
tuning of its own.

### F-2 · `PLAYTEST` · Traveling band geometry is unmeasured against a real board
The band span (`min(totalLength × 0.14, 0.4)` unit-hex-lengths) and `drawRouteSignalBand`'s glow/core stroke
widths (railWidth-derived) are eyeballed defaults. **Watch:** at typical zoom, whether the band reads as a
single traveling pulse rather than a smear (too long) or a barely-visible dot (too short), and whether the
glow pass is visible without bleeding into the route's own base line.

### F-3 · `RESOLVED` (2026-09-21 badge-reaction simplification) · Multi-route badge perimeter segmentation
Previously: `allocateBadgePerimeter`'s equal contiguous shares and per-segment pulses had never been watched
against an actual multi-train Run Routes session sharing one printed badge. Moot now — perimeter segmentation
was removed entirely along with the rest of the persistent-border design (see VF-2's REMOVED DESIGN section
above). Superseded by F-7 below, which asks the equivalent question of the new coincidence-collapse design.

### F-4 · `RESOLVED` (2026-09-21 badge-reaction simplification) · The contrast fallback is one uniform keyline, not per-colour tuning
Previously: three of the six route inks (amber, green, lime) were borderline-contrast against the white badge
interior as a BORDER colour, patched with a uniform dark keyline (design note 16, `hexCanvasPrimitives.ts`).
Moot now — the badge border is plain black at all times, so no route colour is ever drawn as a border stroke
and the keyline it existed to support was removed along with it. `ROUTE_TRAIN_COLORS` itself was never in
question and needed no re-audit.

**Further update (2026-09-21 finalize pass):** moot twice over now. The interior tint itself is gone too —
the badge interior is plain white at every moment, resting or reacting, with no colour input of any kind (see
VF-2 above, and F-7's resolution below). There is no tint left to contrast-check against anything.

### F-7 · `RESOLVED` (2026-09-21 finalize pass) · Badge-hit tint strength is moot -- the tint is gone
Previously: `BADGE_HIT_MAX_TINT_SOLO`/`_COINCIDENCE` were first-guess numbers awaiting playtest. Moot now --
the finalize pass replaced the interior colour flush with a scale-only mechanical pop (see VF-2 above), so
there is no tint strength left to tune; both constants, and `BADGE_HIT_NEUTRAL_COLOR`, were removed from
`routeLivery.ts` entirely. The coincidence window itself (`BADGE_HIT_COINCIDENCE_WINDOW_MS`, 120ms) is
unchanged by the finalize pass and its own feel is still genuinely open -- carried forward as part of F-8
below, which asks the equivalent "is this number right" question of the new pop design.

### F-8 · `PLAYTEST` · Pop scale, timing and undershoot are first-guess numbers, unwatched
`BADGE_POP_PEAK_SOLO` (1.11) / `BADGE_POP_PEAK_COINCIDENCE` (1.17), the 60ms/130ms/260ms attack/undershoot/
settle timings, and the 0.985/0.975 undershoot depths (`routeSignalGeometry.ts`) are a first coherent guess,
deliberately not hand-tuned further per the same brief instruction that kept the earlier tint numbers
unwatched. `BADGE_HIT_COINCIDENCE_WINDOW_MS` (120ms, unchanged from the original design) sits inside the
requested 100-150ms range but its own feel against the new pop is likewise unwatched. **Watch:** whether
111%/117% read as a satisfying mechanical "tick" rather than either a barely-visible twitch (too small) or a
jarring jump (too large); whether 260ms feels connected to the traveling signal's own speed or arrives as a
disconnected, out-of-sync beat; whether the 98.5%/97.5% undershoot is perceptible at all at real running
speed, and if so whether it reads as "settling into place" (intended) or as jitter; whether the coincidence
pop (117%) reads as distinctly one bigger hit rather than a different kind of badge state; and whether 120ms
still feels right for "the same moment" now that the reaction it groups is a pop rather than a tint.

### F-5 · `OPEN` · The traveling signal and per-hex badge lookup run whenever any route overlay exists
Same shape as VF-1's C-7 and VF-3's E-6: the rAF clock and the per-frame `pointOnRouteTrack` sampling run for
as long as `routeOverlays.length > 0`, whether or not the board is actually the visible/active surface.
Harmless — the work is cheap unit-hex-space math, gated to skip entirely under reduced motion — but, as noted
in those two prior entries, it is not currently short-circuited for an off-screen or inactive board. Low
priority.

---

## Part G — Open review items (VF-4)

### G-1 · `OPEN` · Audio is unanswered, and the flip is silent until it is
The brief allows a cue only if "an existing suitable mechanical cue already exists and can be reused
cleanly", and rules out a generic cinematic boom or whoosh. The three clips in `public/audio` that could pass
for a mechanical plate — `telegraph.mp3`, `watch-wind.mp3`, `steam_hiss.mp3` — are all owned by
`variantSfx.ts`'s FLAVOUR-TEXT matcher (`/telegraph/i`, `/pocket watch/i`, `/boiler|steam/i`), where each
means "the line the ticker just printed mentions this thing". Giving one a second, structural meaning is how
a cue stops meaning anything, and `floated.mp3`/`presidency.mp3` are one-off ceremonial stingers for other
events. **So the flip ships silent.** What would close this: a short split-flap or relay-clack asset of its
own, fired on the fold's start rather than the midpoint (the sound of a plate releasing, not of it landing),
under the master SFX switch with no category of its own — the rule #1457 established for the presidency cue.
**Owner decision needed:** whether a phase change deserves a sound at all. It happens five times a game and
is already the loudest thing on the board in consequence terms.

### G-2 · `PLAYTEST` · The timings are first-guess numbers
200 ms fold, 260 ms unfold, 6° overshoot, 60 ms settle — chosen against the brief's 450–600 ms band and
against VF-3's half-turn (deliberately much shorter: a corporation floats once, a phase changes five times).
Nobody has watched one. **Risk:** at the badge's actual size (micro type in a pill roughly 90 px wide) a 200 ms
fold may read as a flicker rather than a mechanism, and the 6° overshoot may be invisible. **What to watch:**
whether the plate reads as *turning over* or merely as *text changing*; if it flickers, the fold is the beat
to lengthen, not the unfold.

### G-3 · `PLAYTEST` · The perspective figure
`perspective(200px)` is applied per-element rather than on a parent, because the badge's parents are shared
action-bar rails whose every future child would inherit a `perspective` property. 200 px against a ~24 px-tall
badge is a strong foreshortening, chosen so the fold reads as depth rather than as a vertical squash.
**Risk:** at `uiScale` settings well away from 1.0 the badge's rendered height changes while the perspective
distance does not, so the effect is scale-dependent in a way the rest of the chrome is not. **What to watch:**
the same flip at 0.63 and at 1.5.

### G-4 · `PLAYTEST` · The tint channel currently carries no pixels
`PHASE_TINT_STYLES` maps yellow, green and brown to one neutral badge style (the app-scaling neutral default),
so "swap to the new phase tint" is today a swap between three identical styles. The comparison and the swap
are both written on `label` + `tint` anyway, because this module's job is to notice when the BADGE changes and
the day the tints come back is not the day to remember it. **Nothing to do unless the tints return** — at which
point the midpoint swap is already correct and this entry closes itself.

### G-5 · `OWNER DECISION` · Two badges, two copies of one flip
The bar prints the phase badge twice — the Operating Round panel's left rail and the action row's lead — and
both render the same component, so both play the identical flip off the same event. They are the same badge
shown in two branches, so this is a correct reading rather than a collision, and it is the same arrangement
every roster card has under VF-1/VF-3. Recorded so it is never mistaken for an oversight.

### G-6 · `PLAYTEST` · The Phase 2 → 3 sequencing, end to end
The named case in the brief: the badge must turn over before `PhaseThreeNoticeModal` takes the screen. The
modal waits for the badge's `settled` milestone — 520 ms in full motion, 200 ms under reduced motion.
**Risk in the other direction:** half a second of nothing happening after a purchase may read as lag rather
than as sequencing, especially on the client that dispatched. **What to watch:** whether the hold feels like a
beat or like a stall; if it stalls, the modal can move to the `faceSwapped` milestone (what the era toast
uses) and still satisfy the ruling — a one-word change now that the holds are named rather than numbered.

### G-7 · `OPEN` · A phase change while the bar is unmounted
The event is held for `PHASE_BADGE_TOTAL_MS` and then cleared, whoever is watching. A player on a tab where
the action bar is not mounted misses the flip entirely and sees the new phase already settled when they
return — which is correct (the badge is authoritative and the flourish is not), and the same shape as C-7 and
E-6 for the cards. Recorded rather than fixed: the alternative is replaying a ceremony for an event that is
no longer news.

---

## Part H — Open review items (VF-6)

### H-1 · `OWNER DECISION` · #901's Top Bar badge is removed, and the one coverage hole is filled
#901 put a persistent "BANK BROKEN · final OR set" badge in the Top Bar, and its reasoning is inherited
whole: there is a stretch of real play between the break and the ending during which every decision is a
last decision. What did not survive is it being a SECOND thing. The ticket says the same fact more precisely
— "2 ORs remaining", then "1 OR remaining", from the round machine itself, where the Top Bar could only say
"final OR set" because it could not see the calendar.

**The coverage was audited before the badge went, not assumed.** The action bar renders on every tab (#1084),
so a playing client has the ticket wherever the badge used to be. It is *not* rendered in three states, and
each was resolved rather than accepted:

- **`GameEnd`** — #1442 replaces the whole bar with the game-over strip. This is the handoff the batch wants,
  and `bankBrokenStatus` independently answers `null` there, so the decision is taken twice on purpose.
- **Spectator** — the dock replaces the bar with a read-only notice. **This was the genuine hole**, and it is
  filled by rendering the *same* `BankTicket` component off the *same* `bankBroken` derivation inside that
  notice. One component, one authority — which is what "one persistent Bank-broken authority" has to mean.
  It carries no stamp: a spectator gets the persistent state, and the one-time ceremony belongs to the bar.
- **Replay scrub** — the dock says in words that the board shown is historical. **Deliberately not covered:**
  a live endgame ticket beside "showing the board as it stood at the end of OR 2.1" is a mixed message, and
  the live ticket returns the moment the scrub is dragged back to Final. This is the one narrowing against
  #901's coverage, recorded rather than left to be found. **If the owner would rather the scrub carried it,
  it is one line in the same branch.**

### H-2 · `RESOLVED` (audio wiring pass) · Audio is answered: `bank-broken.mp3`
The brief asks for a railway/ticket-office stamp, a heavy rubber stamp, a short mechanical counter or
office-register impact, a decisive thunk — and rules out a cinematic boom, an explosion, a metallic screech,
a long reverberant clang and a cash-register ding. **The tree was audited clip by clip and holds none of
them.** Every percussive asset it has is one of the things ruled out (`explosion.mp3`, `crash.mp3`,
`rockslide.mp3`, `thunder.mp3`, `spooky_gong.mp3`, `church-bells.mp3`, `cha-ching.mp3`, `coins-clinking.mp3`,
`sad-trombone.mp3`); the three mechanical clips that are not (`telegraph.mp3`, `watch-wind.mp3`,
`camera-shutter.mp3`) are each already owned by `variantSfx.ts`'s flavour-text matcher, where they mean "the
line the ticker just printed mentions this thing"; and `floated.mp3`/`presidency.mp3` are one-off ceremonial
stingers for other events. **So the break ships silent.**
**Desired asset, exactly:** one dry rubber-stamp thunk, roughly 250–400 ms, a single hard onset with no tail
and no reverb — a wooden handle driving an inked die onto a counter, not a door slamming. **Cue point:**
played so the clip's own principal impact lands on the `stamped` milestone (200 ms full motion, 90 ms
reduced), measured the way VF-3 measured `floated.mp3`'s 458 ms offset rather than assumed to be sample zero.
Under the master SFX switch with no category of its own, on #1457's rule for the presidency cue.

**RESOLVED: commissioned, and it is 1.36s rather than the 250–400 ms specified above.** Longer than
asked for, and kept: the extra length is decay rather than tail — the attack is over by 35 ms and the
rest is the die settling on the counter, which is the one part of "a wooden handle driving an inked die"
the short version would have lost. Its principal impact is at 12 ms, so the cue starts 188 ms into the
sequence (78 ms reduced) and the thunk lands on `stamped` on either schedule. See the AW section.

### H-3 · `PLAYTEST` · The ticket silhouette at actual Action Bar scale
Four 5 px chamfers and one dashed stub rule 9 px in, on a badge roughly 22 px tall at `FONT_SIZE.micro`.
Chosen so the shape reads before the label does without becoming decoration. **Risk:** at `uiScale` 0.63 the
chamfers are about 3 device pixels and may simply read as a slightly ragged rectangle; the dashed rule may
alias into a solid line. **What to watch:** whether the badge reads as a *ticket* or merely as *a square
badge among pills* — and if the latter, whether the answer is a deeper chamfer or a second perforation rather
than more detail.

### H-4 · `PLAYTEST` · The stamp's 960 ms, and whether the hold is long enough to read
200 ms draw-in, stamp at 200 ms, commit at 540 ms, settled at 960 ms. The word BANK BROKEN is legible for
roughly 340 ms, which is the shortest interval that reliably reads at this size. **Risk in both directions:**
too short and the most consequential event in the game goes by as a flicker in a status bar; too long and it
delays the player's read of what is left. **What to watch:** whether a player who was looking at the board
rather than the bar notices it at all — and if not, whether the answer is a longer hold or a different
surface, which would be a new brief rather than a tuning.

### H-5 · `PLAYTEST` · The rainbow ring at badge scale, and its contrast
The ring is `PRIVATE_POWER_GLOW_STOPS` across a 2 px border on a badge ~90 px wide, where the mini-auction
card wears the same palette across a 3/6 px border on a card several hundred pixels wide. **Risk:** eight hue
stops compressed into 90 px may read as a muddy stripe rather than as the special-event language it is
borrowing, which would break the association #727 exists to protect. **What to watch:** side by side with a
contested mini-auction card. If it muddies, the fix is fewer stops for this surface — *taken from the same
array*, never a new palette by eye.

### H-6 · `OPEN` · The mini-auction card writes the palette out by hand
`WaterfallAuctionDashboard.tsx` spells the eight stops inline in its CSS rather than importing
`PRIVATE_POWER_GLOW_STOPS`, which is the exact drift #727 created that constant to prevent ("two hard-coded
palettes drifting apart is how the association quietly stops being one"). **Pre-existing, and deliberately
not changed by this batch** — the ticket imports the shared array, so there are now two consumers of the
constant and one hand-written copy. **Smallest fix:** interpolate the array into that card's template
literal, exactly as `bankBreakFlourish.ts` does. Left for a batch that has reason to open that file.

### H-7 · `PLAYTEST` · Two tickets on screen at once
The bar prints the ticket on both rails (the Operating Round panel's left rail and the action row's lead),
and in an Operating Round both can be mounted. Each runs its own copy of the stamp off the same token, so
they play in lockstep — the same arrangement VF-4's two phase badges have, and correct rather than a
collision. **What to watch:** whether two tickets stamping simultaneously reads as emphasis or as
duplication. Recorded so it is never mistaken for an oversight.

### H-8 · `OWNER DECISION` · The countdown is rounds, not turns
"2 ORs remaining" counts Operating Rounds, not corporation turns, so the number sits still through an entire
round while six corporations operate. That is the unit the rule is written in (#898 ends the game at an OR
SET boundary) and the unit a player plans in. A turn-level countdown would be more granular and would be
counting something the rule does not care about. Recorded as a choice.

---

## Part I — Open review items (VF-7)

### I-1 · `RESOLVED` (VF-8) · The silence mechanism is retired in full
#896a built a per-corporation, per-cause opt-out because BOTH fleet-loss modals were unavoidable. That
premise no longer holds for rust: the modal is gated on tutorial mode, so "do I want to be told about rust
for PRR" has been replaced by "am I still being taught", and a player who answers no turns tutorials off once
instead of ticking a box per corporation as each fleet is emptied. Two independent systems deciding whether
one modal appears is what the brief rules out, and is #891's shape.

**The limit half is kept, and the distinction is the point.** A train-limit drop still has no visual
vocabulary of its own — that is a later batch — so its modal is still the only thing that tells a president a
train was taken, and it is still unavoidable in the way #896a was written for. So the store is not deleted:
its cause parameter is narrowed to `SilenceableCause = "limit"`, which makes the removal a compile error
rather than a convention, and `silenceLabel` returns `null` for rust so the modal renders no checkbox rather
than an inert one. **When the train-limit vocabulary lands, this entry should be revisited: if that modal
also becomes tutorial-only, the whole mechanism goes.**

**RESOLVED BY VF-8, and the revisit found more than it went looking for.** The train-limit vocabulary is
VF-8, and its modal did become tutorial-only — which on its own would have retired the store. But the audit
that came with it found the premise had been false for longer than that: the Train Limit modal has been
UNREACHABLE under v2 rules since #1530, because the phase change takes nothing and `describeFleetLosses`
splices the president's `DiscardTrain` out of its own diff. So the checkbox has been offering to silence a
dialog that never fired. The whole mechanism is gone — store, types, storage keys, label and checkbox — and
the explanation now hangs off the action the president takes, where the chosen train is actually known.
*The lesson worth keeping is the one VF-7 nearly missed:* "this half still has a real reader" was an
argument about the code as written, and the reader had already been gone for eighteen design notes. It was
settled here by running the reducer, which is the only way it could have been.

### I-2 · `OWNER DECISION` · Tutorial mode gained a control, because it now decides something
#412 added `tutorialModeEnabled` and deliberately gave it no UI — its only job was gating one navigation (the
first-Operating-Round redirect to the market chart), the default WAS the behaviour, and turning it on was for
somebody deliberately teaching. VF-7 gives it a second and much louder reader: it now decides whether a
blocking dialog interrupts a phase change. Shipping that with no way to reach the flag would have shipped the
"tutorial ON" half of this batch as code nobody can run, so a checkbox was added to the Tutorials front door
(`TutorialLibrary`), beside the existing "Turn tutorials off" preference rather than in a second home.
**Flagged for owner review:** this is a settings-surface change inside a flourish batch, and if a general
settings screen is coming it belongs there instead.

### I-3 · `RESOLVED` (audio wiring pass) · Audio is answered: `rust.mp3`
Wanted: ONE cue per global rust event — never one per train — short, brittle, dry, a single useful onset,
perhaps a small muted debris component, fired on the **`fractured` milestone** (190 ms full motion, 90 ms
reduced), never on the beginning of oxidation. Under the master SFX switch with no category of its own
(#1457's rule for the presidency cue). **The tree has no unowned candidate.** Every clip with the right
envelope is already claimed by `variantSfx.ts`'s flavour-text matcher — `metal_clunk.mp3`
(`/coupling|axles|wheels/`), `engine_trouble.mp3` (`/broke down|defective/`), `machinery.mp3`
(`/iron|factory|mills/`), `tree-branch.mp3` (`/fallen tree/`), `iec-crack.mp3` (`/ice/`) — and the rest are
the excluded list itself (`crash.mp3`, `explosion.mp3`, `rockslide.mp3`, `steam_hiss.mp3`, `shovel.mp3`,
`thunder.mp3`, `spooky_gong.mp3`).
**The near miss is named rather than buried, because the owner may want to overrule cheaply:**
`iec-crack.mp3` is exactly the right envelope — a dry brittle fracture, one onset, no tail — and the only
objection is that a flavour line mentioning ice would then play the sound of trains being destroyed. #1040
records that matcher as the worst false-positive in the table ("23 of 25 matches were service, office, price,
twice, choice"), which cuts both ways: the collision is rare, and it is with a matcher already known to fire
wrongly. **Owner call:** reuse it, or commission a cast-iron fracture of its own.

**RESOLVED: commissioned, so `iec-crack.mp3` keeps its ice.** `rust.mp3` is wired to the `fractured`
milestone of whichever schedule is playing, once per global event. See the AW section above for the
alignment — and note that measuring it is what revealed the clip's loudest moment is *not* its crack. The
audit also found that the failure phase did not justify a brittle-break sound, and the chip now comes
apart; the remaining question is a visual one and is K-7 below.

### I-4 · `OWNER DECISION` · No stagger between corporations, and why
The brief permits "a tiny deterministic stagger ... if it materially improves readability", on two
conditions: the event stays short, and the order must not imply rules precedence that does not exist. The
second condition is the problem — any stagger must be ordered by something, and the only orders available
are the operating order or the company id, both of which a player will read as "this corporation lost its
trains first". One reducer call destroys every doomed train in the same instant and 1830 has no sequence
among them. **So every chip runs on one clock.** If the simultaneous version reads as a single indistinct
flicker at playtest, a stagger can be added — but it should then be ordered by something meaningless *on
purpose* (a hash of the model, say) rather than by anything a player could mistake for precedence.

### I-5 · `PLAYTEST` · The timings are first-guess numbers
190/140/120/80 ms, chosen against the brief's band and against the surface: a rust can take six chips across
eight corporations at once, so the whole thing has to be over quickly. **Risk in both directions:** too fast
and six simultaneous fractures are an indistinct shimmer in a table; too slow and the row is unreadable for
half a second at the exact moment a president is deciding what to buy. **What to watch:** whether a player
can say afterwards WHICH trains they lost — that is the one thing the sequence has to deliver, and it is why
the model stays readable through the fracture.

### I-6 · `PLAYTEST` · The crack at actual chip size
A 0–100 path stretched across a chip roughly 34×24 px (26×24 compact), stroked at 2.4 with
`vector-effect: non-scaling-stroke`. **Risk:** at that size a four-vertex fracture plus a branch may read as
a scribble rather than as a crack, and the branch may be too short to register at all. **What to watch:**
whether it reads as *broken* or as *dirty* — and if the latter, whether the answer is fewer vertices and a
longer branch rather than more detail. Also worth checking at `uiScale` 0.63 and 1.5.

### I-7 · `PLAYTEST` · The oxide against eight liveries
`rgba(107, 63, 42, 0.85)` over the chip body, on cards painted the corporation's own colour — which is the
exact surface #702 measured and found the old translucent warning fills scoring 1.00–1.14:1 against. This
fill is far more opaque than those were, and it DARKENS rather than tints, but it has not been measured
against all eight. **What to watch:** NNH (`#ee7c22`) and any brown-adjacent livery, where an oxide wash may
simply disappear. If it does, the fix is a darker oxide rather than a more saturated one.

### I-8 · `OPEN` · Three of the five `TrainChips` call sites do not receive the event
Wired: the Round Detail corporations table (every fleet at once — the surface a multi-corporation rust is
watched on) and the action bar's acting-corporation strip (the buyer's own chips, and the bar renders on
every tab since #1084). **Not wired:** the Stock Round card fronts and the Ledger's two tables. The Stock
Round is not a gap — rust fires on a train purchase and a reprieve expiry, both Operating Round events, so no
rust event can be live while those cards are on screen. **The Ledger is a real if narrow gap:** a player
sitting on the Ledger tab when a rust fires sees the new rosters appear without a flourish (the action bar
above still animates the acting corporation's). Left unwired rather than threaded through a fourth panel for
a tab nobody watches during a train purchase; it is A-3's fallback behaving correctly rather than a defect.

### I-9 · `PLAYTEST` · Rust outranks both warning animations, and nothing was watched
A chip being destroyed drops the `app-train-rust-critical` pulse and the `app-train-final-run` fade — two
motions on one element read as a rendering fault, and the thing they were counting down to has arrived.
**What to watch:** the Gentle Rust expiry in particular, where a chip that has been breathing at 0.2 opacity
for a whole round suddenly stops, oxidises and fractures. The transition from a deep fade to full-opacity
oxide may read as the chip *recovering* for an instant before it dies.

### I-10 · `OPEN` · Rust's static badge icon is not implemented
The brief asks that the flourish's vocabulary be structured so a later badge-identification pass can derive
the static warning icon from it — a fractured train, a cracked wheel, a crack mark. `crackPath` is the piece
that pass would reuse: it produces a resolution-free fracture from a seed, so a badge icon can be the same
mark at a fixed seed. **Deliberately not implemented here** — the brief says not to unless the implementation
required it, and it did not.

---

## Part J — Open review items (VF-8)

### J-1 · `RESOLVED` (audio wiring pass) · Audio is answered: `train-discard.mp3`
Wanted: ONE cue per discard action — a short dry paper-cutter, a ticket punch, a guillotine lever, a
mechanical ka-chunk; one decisive onset, little or no tail — fired on the **`cut` milestone** (80 ms full
motion, 40 ms reduced). Ruled out by name: sword slash, gore, cinematic whoosh, metallic screech, rust's own
crack, explosion. Under the master SFX switch with no category of its own (#1457's rule for the presidency
cue). **The tree was audited clip by clip and has no unowned candidate, for the third batch running.** Every
clip with a mechanical envelope is claimed by `variantSfx.ts`'s flavour-text matcher — `metal_clunk.mp3`
(`/coupling|axles|wheels/`), `camera-shutter.mp3` (`/photograph/`), `telegraph.mp3`, `watch-wind.mp3`,
`machinery.mp3` (`/iron|factory|mills/`) — and the rest are the excluded list itself.
**The near miss is named rather than buried, because the owner may want to overrule cheaply:**
`camera-shutter.mp3` is exactly the right envelope — a sprung mechanical snap, one onset, no tail, no tone.
It is a shutter rather than a blade, and it already means "the ticker mentioned a photograph". **Owner
call:** reuse it, or commission a paper-cutter of its own. Note that VF-7's near miss (`iec-crack.mp3`) and
this one are different clips, which is the right shape — if the two events ever share a sound the whole
point of inverting the vocabulary is lost.

**RESOLVED: commissioned, so `camera-shutter.mp3` keeps its photograph.** `train-discard.mp3` is wired to
the `cut` milestone of whichever schedule is playing, once per successful `DiscardTrain`. The concern
above is answered structurally: rust and the discard are different files with different envelopes, and
the audio suite asserts they are different files. See the AW section.

### J-2 · `PLAYTEST` · The timings are first-guess numbers, and the transfer is the long part
80/40/80/160 ms. The transfer is deliberately the longest beat — it is the only thing that distinguishes
this from a destruction — but it is also 160 ms of a chip moving ten pixels, which may read as a hesitation
rather than as a departure. **Risk in both directions:** shorten it and the chip simply vanishes like a
rusted one; lengthen it and a president waits half a second before the panel is usable again, while under a
discard obligation with nothing else they are allowed to do. **What to watch:** whether a player who sees
only the animation can say afterwards that the train went *somewhere* rather than that it was destroyed.

### J-3 · `PLAYTEST` · The cut at actual chip size
One line across a chip roughly 34×24 px (26×24 compact), stroked at 1.5 with
`vector-effect: non-scaling-stroke`, landing between 42% and 58% of the width with up to 3% of slant.
**Risk:** at that size the difference between "a cut" and "a vertical divider between two characters" is a
couple of pixels of slant and the three-pixel part that follows it. If the part is what carries the reading,
the cut is doing nothing on the reduced-motion path, where there is no part. **What to watch:** whether a
reduced-motion reader can tell a discard from a rust at all — that is the one thing J-1's silence and the
static cut have to deliver between them. Also worth checking at `uiScale` 0.63 and 1.5.

### J-4 · `OWNER DECISION` · The Bank Pool receiving reaction is Option B, and usually invisible
The brief offered a literal transfer toward the Bank Pool (A) or a clean local departure plus a receiving
state (B). B was chosen on an audit rather than on taste: pooled trains render **only** as rows in
`TrainPurchasePanel`, on the Buy Trains step, for the acting corporation's president. A president answering
a discard obligation is very often not the acting president — that is the common case, since the obligation
is created by somebody else's purchase — so for most discards there is no destination on screen to fly to,
and Option A would have needed A-1's forbidden portal to reach one that was. **The consequence to accept:**
the receiving pop is a bonus that fires for the minority of discards where the panel is open, and the
departure has to carry the whole meaning on its own for the rest. **If that proves too weak at playtest**,
the cheap fix is a Bank Pool count somewhere persistent rather than a longer animation.

### J-5 · `OPEN` · Three of the five `TrainChips` call sites do not receive the event
Exactly VF-7's I-8, and wired the same way: the Round Detail corporations table and the action bar's
acting-corporation strip receive it; the Stock Round card fronts and the Ledger's two tables do not. **The
Stock Round is genuinely not a gap** — a discard obligation exists only inside an Operating Round. **The
Ledger is the same narrow gap rust has:** a player sitting on that tab sees the roster change without a cut.
Left unwired rather than threaded through a fourth panel; A-3's fallback behaving correctly.

### J-6 · `OPEN` · The discard's static badge icon is not implemented
The brief asks that the vocabulary be structured so a later badge pass can derive a static "train limit
exceeded" mark from it. `discardCut` is the piece that pass would reuse — it produces a position and a slant
from a seed, so a badge can be the same blade at a fixed seed, and the contrast with VF-7's `crackPath`
badge (I-10) is already built in: a straight line against a fracture. **Deliberately not implemented here**,
on the brief's instruction not to unless the implementation required it, and it did not.

### J-7 · `OWNER DECISION` · Two staging sources now share one chip row, and rust wins the tie
`TrainChips` stages a pre-rust roster or a pre-discard one, and if both were ever live for one corporation
at once, rust's is used. The two cannot collide under today's rules — rust fires on a phase change or a
reprieve expiry, a discard on the president's own answer to an obligation — so this is a guard rather than a
behaviour anyone will see. **The direction is the deliberate part:** a destroyed train must not be drawn as
merely transferred, so the more serious event wins. **Flagged because it is a rule stated in a presentation
file**, which is the shape Part A's A-4 is suspicious of; it is defensible here only because it decides
which of two flourishes plays and not what is true.

### J-8 · `PLAYTEST` · A corporation two over the limit discards twice in a row
Reachable and not rare: a Phase 5 arrival can leave a fleet two over. The second `DiscardTrain` supersedes
the first on its own token (#1060), so the row restarts from the tension beat rather than finding the first
sequence still finishing. **What to watch:** whether two cuts 500 ms apart read as two decisions or as one
stutter — and whether the Tutorial modal, held on each `settled`, ends up queued twice for what a player
experiences as one obligation. The dedupe key (#1032) is content-derived, so two discards of *different*
models queue two notices by design.

---

## Part K — Open review items (warning marks)

### K-1 · `OWNER DECISION` · The Gentle Rust final-run badge takes the rust mark
The brief names Rust and Train Limit. The `Final Run: 2-trains` badge (#1004/#1033) is a third, and it was
given the crack rather than left on `⚠`. **The reasoning:** it and the rust countdown are the same rule at
two moments — one purchase from rusting, versus rusted and running once more — so two different
classification marks on them, in one group, at one escalation, would be the exact confusion this pass
exists to remove. **The objection worth hearing:** it is the only badge in the row describing something
that has ALREADY happened rather than something coming, which is arguably its own category and might
deserve its own mark. Cheap either way — one component swap in one JSX site.

### K-2 · `PLAYTEST` · The crack at uiScale 0.63
The mark is `1.15em` against an 11px label, so ~12.6px at scale 1.0 and **~8px at 0.63**. At 8px the
rendered candidates all collapse toward "a tile with a diagonal stroke in it"; what the chosen seed keeps
longest is the fork near the top, which is what stops it reading as a prohibition sign. **What to watch:**
whether a player at 0.63 can tell the rust badge from the limit badge WITHOUT reading either — that is the
whole claim. If not, the cheap fixes in order are: drop the tile (the capsule is already a frame), then
raise the crack's weight, then raise `MARK_SIZE`. **Do not fix it by making the badges taller** — the
brief rules that out and #1005 already records the rail wrapping when the badges grow.

### K-3 · `PLAYTEST` · Whether the tile reads as a train chip or as a box
The tile is a rounded square (`rx` 4 of 22) at 0.40 opacity, and a real train chip in this app is a
1.4:1 pill. The oblong version was tried and rejected on rendering — it flattens the fracture into a
smudge below ~16px — so the mark is deliberately squarer than the thing it depicts. **Risk:** it may read
as a generic "item" box rather than as a train, in which case the mark says "something is cracking" rather
than "a train is". **What to watch:** whether anyone reads it as a train at all without being told; if
nobody does, the tile is doing less work than it costs and K-2's first fix (drop it) gets easier.

### K-4 · `OPEN` · The fallback capacity glyph has never been rendered in the product
`CapacityMark` falls back to a ceiling-and-down-arrow when `capacity` is null, per the brief's "do not
fabricate numbers". It is unreachable from the Action Bar: `purchaseWarnings` constructs the train-limit
warning only inside the guard that computes both figures. Asserted in the harness and drawn nowhere else.
**If a future variant ever produces a limit change the depot cannot resolve**, this is the branch that
runs, and it will be the first time anyone has seen it.

### K-5 · `PLAYTEST` · `4→3` beside a label that does not carry the figures
#889 deliberately took "Limit X → Y" off this badge because it was the busiest string in the row, and this
pass puts two digits and an arrow back on the front of it. The label itself is unchanged, so there is no
redundancy today — but the badge is now `4→3 Train Limit Drops in 2 Buys`, which is two countdowns'
worth of numerals in one pill. **What to watch:** whether the eye reads `4→3` as part of the sentence
rather than as a mark. It is set a hair smaller with extra letter-spacing to hold it apart; if that is not
enough the next lever is a thin divider, NOT a colour (brief §2) and NOT a box (brief §7).

### K-6 · `OPEN` · The rust mark and VF-7's chips can now disagree about a fracture, in one direction
The badge calls `crackPath(41, 3)` and the chips call it with the default 4. A change to the generator's
SHAPE rules moves both, which is the point of reusing it — but a change that only makes sense at four
steps (a fifth vertex, say, or a second branch) could quietly make the badge worse without failing
anything. The harness asserts identity with `crackPath(41, 3)`, so the badge will keep matching the
generator; what it cannot assert is that the result still looks like a break at 12px. **Whoever next edits
`crackPath`: rasterise the badge as well as the chip.**

### K-7 · `PLAYTEST` · The chip in pieces, at 24px and at speed
Added by the audio wiring pass, and it is the visual half of that batch. The failing chip now breaks into
two or three clipped pieces that drift 3px apart and fade over 120ms. **Risk in both directions:** at
34×24 with three pieces, the smallest chunky piece is around an 8×8 block, and 120ms is barely four
frames — it may read as a flicker rather than as a break, in which case nothing is gained over the
shudder it replaced. Too visible and it starts to compete with VF-8's clean cut, which is the one
distinction the two vocabularies exist to keep. **What to watch:** whether a player can say afterwards
that the train *broke* rather than merely vanished — and whether the seam that opens along the extended
branch (which was never drawn as a crack) reads as the flaw running out, or as a piece falling off
somewhere nothing had cracked. **If it is too subtle**, the cheap levers in order are a longer `fail`
beat, a larger drift, or dropping to two pieces always (which is more legible per piece).

### K-8 · `PLAYTEST` · Perceptual loudness across the three cues
No gain staging was applied. The three assets were left at the library's single `SFX_VOLUME` like every
other cue, because the project has no per-cue gain mechanism and the brief ruled out inventing a
processing pass. **Measured peaks are close** — `bank-broken.mp3` and `rust.mp3` both hit full scale and
`train-discard.mp3` peaks around 0.8 — but peak is not loudness: `bank-broken.mp3` is a dense 15–22k RMS
across its whole attack, while `rust.mp3`'s crack is a 10k RMS spike out of near-silence and
`train-discard.mp3` sits around 9k. **So the Bank thunk will almost certainly sound the loudest of the
three, by a noticeable margin.** That may be right — it is the most consequential event in the game — but
it was not chosen, it fell out of the files. **What to watch:** whether the rust crack is audible over a
busy Operating Round when the Bank cue has set the expectation. If it needs fixing, the honest fix is
editing the assets, not adding a gain layer for three clips.

### K-9 · `NOT REACHABLE` (audit, 2026-09-22) · Three cues cannot collide
`MAX_CONCURRENT_SFX` is 3 and these cues are capped (not `uncapped`, which the ceremony uses). The
original worry was that "a train purchase that turns the phase can rust trains AND break the Bank in one
dispatch" — so three flourish cues plus the flavour matcher would be the first time this app had that
many one-shots competing.

**THAT PREMISE IS FALSE, and the correction is worth more than the item was.** The claim conflated the
train PURCHASE, which transfers its price *to* the Bank, with the RUST that purchase causes, which
transfers nothing at all. Audited through the reducer rather than argued
(`utils/rustCashNeutrality.test.ts`, 14 cases):

- **rust is cash-neutral on every path** — a corporation's train, several corporations' trains, a train
  rusting out of the Bank Pool (which does *not* pay its face value in either direction), a Gentle Rust
  marking, and a Gentle Rust expiry. `applyPhaseChange` writes `public_companies`, `private_companies` and
  `returned_trains` and nothing else; a Bank at $1 with eight trains destroyed around it is still at $1
  with no latch;
- **the purchase is separable from its consequence by arithmetic**, not by a final balance: the Bank rises
  by *exactly* the train's price across a phase-changing purchase, and by the same amount when the second
  train of that tier rusts nothing;
- **the two events need opposite money flows.** Rust needs a phase change; a phase change needs a train
  arriving from the depot or the Diesel exchange; both credit the Bank before the phase settles and
  neither calls `debitBank`. The break needs `debitBank` past zero (#1561), and its three callers pay
  dividends, pay private revenue and capitalise a float — none buys a train. There is no arm that does
  both and no near miss;
- **and the dispatch chain does not smuggle one in.** Every action runs `applyOneAction` then
  `settleRoundTransitions`, and that transition *can* pay private revenue — a debit. But it fires on
  `stock_round_just_ended` / `operating_round_just_ended`, which a purchase does not set.

**The other two pairs are also unreachable from one action.** Bank Break + Discard: `DiscardTrain` touches
no money field at all (6.6.1, "the corporation receives no payment"). Rust + Discard: a phase change can
create a train-limit *obligation* in the same instant it rusts, but #1530 made the obligation and the
discard two different things — the phase takes nothing, and the president's `DiscardTrain` is a separate
action by a different actor, possibly several turns later. **The limit becoming active is not the
discard.**

**SO NO AUDIO COLLISION ARBITRATION WAS ADDED.** Two cues can still sound close together in *time* — a
discard follows the phase change that forced it — but never from one action, and `playVariantCue`'s
existing cap already governs that case as it governs every other. The only thing left for playtest is
whether two cues a second or two apart read as two events, which is J-2/K-8 territory rather than a
collision.

*A note on the audit itself, because it cost two rewrites.* The first fixture parked six 2-trains on one
corporation to empty the depot's cheap tiers, and the reducer refused every dispatch: "B&O holds 2 trains
more than the limit of 4 — B&O's president must discard before anything else happens." That is
`pendingDiscardBlock` doing its job, and it is the same rule K-9 is about: while any corporation is over
the limit, *nothing* else happens. And the first bank-break case wrapped its assertions in
`if (after !== before)` around a dispatch that was being refused, so it passed while proving nothing —
#886's vacuity wearing a conditional instead of a backwards slice.
