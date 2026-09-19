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

**A-1. Slide-out movement across the application shell is reserved for DOLLAR transactions.**
The dividend machine (#1060) and the treasury machine (#1272) own that vocabulary. Anything that is not money
is presented where it happens — no screen-space flight, no `document.body` portal, no `position: fixed`.
Established by the scrapping of #1450. Enforced in `stockCardFocus.test.tsx`.

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
| VF-2 | Route-running animation | `NOT STARTED` |
| VF-3 | Corporation float sequence | `NOT STARTED` |
| VF-4 | Phase transitions | `NOT STARTED` |
| VF-5 | Tile-lay animation | **IMPLEMENTATION COMPLETE — awaiting visual playtest after rules hardening** |
| VF-6 | Bank-break presentation | `NOT STARTED` |

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
