# UI action plan — 7 September 2026

Aggregated from `TRIAGE_2026-09-06.md` (§2.4, §2.5, §4), `TRIAGE_2026-09-05.md` (the **L** verdicts), and
`MIGRATION_PLAN.md` (§6 open items, §7's "cosmetic items run in parallel"). Only client-side rendering and
shell work is here. Nothing structural (§3 of the triage), no reducer changes, no spec rulings.

**Rule for every item:** components only, own commit per batch, `tsc` + the suites touching the file. None of
these touch the log, so the golden master and the divergence alarm are not affected.

---

## Batch 0 — precondition, one retest (no code)

`TRIAGE_2026-09-06.md` §1 is still owed: #1237 and #1238 on a freshly rebuilt server. **It gates Batch 3** —
#1238 is the likeliest reason the train-purchase toast "is not registering" (a purchase that ends a turn
arrived with its `PassTurn` and was silenced as history). If the toast now shows on both screens, Batch 3
is a design change rather than a bug fix and can be judged on its own merits.

---

## Batch 1 — quick wins, one commit each

| # | Item | Source | Where |
|---|---|---|---|
| 1.1 | Square the tab viewport edges (rounded leftmost tab reads as disconnected) | T06 §4.4 | tabbed board view in `App.tsx` / tab CSS |
| 1.2 | Screen flash on "Host Game" | T06 §4.4 | lobby → waiting room transition |
| 1.3 | Intro's final "Powered by Neta DAO" hold ~20% too long | T06 §4.4 | cinematic intro timings |
| 1.4 | Yellow Sign video shows a black box | T05 22a | `YellowSignOverlay.tsx` (blend-mode / clip keying, see design note 1093) |
| 1.5 | Carcosa Awaits video shows a black box | T05 22d | `CarcosaMark.tsx` |
| 1.6 | Yellow Sign log line should be yellow, not red/green | T05 22c | activity log styling |
| 1.7 | Mini-auction siblings lit, look clickable | T05 2 | `WaterfallAuctionDashboard.tsx` |
| 1.8 | Par/IPO tray gigantic | T05 9a | `StockMarketRenderer.tsx` |
| 1.9 | False "Train Limit" modal when the Mark takes a train — a corporation that just *lost* a train cannot be over the limit | T05 22b (narration half) | `fleetLossNotice.ts` — `describeFleetLosses` diff emits `"limit"` for a Mark removal |
| 1.10 | Tiles tab: tiles barely wider than the supply numbers beneath them — scale tiles up, nudge tile names up too | 7 Sep | tile tray |
| 1.11 | Clicking "Ready" in the waiting room zooms the screen in slightly | 7 Sep | `SandboxWaitingRoom.tsx` — likely a layout reflow / transform on the ready state |

---

## Batch 2 — cosmetic bugs

| # | Item | Source | Notes |
|---|---|---|---|
| 2.1 | Stock Market tab: splay corporation tokens **horizontally**. Stops covering the cell value; fixes the hover that lifts a token *underneath* its neighbour | T06 §4.4 + T05 9 | `StockMarketRenderer.tsx`, `MarketToken.tsx` |
| 2.2 | Dividends mini-chart animates in the wrong coordinate space (rise = 5 cells right; $90→$82 teleports) | T06 §2.4 + T05 10 | `StockMarketPreview.tsx`. Reads as par-box coords used for price-grid coords (#415). **Unblocked:** the plan deferred this until Phase 1 landed — it has. |
| 2.3 | REGRESSION: "your turn" whistle fires at game start instead of after the intro | T06 §2.5 | Audio-on-mount. Check whether the trigger moved when the intro tests were rewritten (title card removed, −7 tests). Interacts with #1239's skip-titles path, which leaves `introPlayingRef` false *on purpose*. |
| 2.4 | Yellow Sign sequence on the **non-acting** player's screen: black box, no video — and they were on the Stock Market tab, so a working video would still have told them nothing about what happened | 7 Sep | Same defect as 1.4 seen from the other seat; fix together. **Decision needed** — see below. |

**2.4 decision.** The original request was "every player's screen". Two candidates:

- **(i) Active player only.** Simplest; everyone else learns from the yellow log line (1.6) and the fleet-loss notice.
- **(ii) Rail Map viewport only, for whoever is looking at it.** Keeps the spectacle for watchers of the acting
  corporation, never paints over the Stock Market tab. Anyone elsewhere gets the log line.

Recommend **(ii)**: it is the overlay's natural home (it is composited over the board via `mix-blend-mode:
screen`, which is why it turns into a black box anywhere else), and a player who switches to the map
mid-sequence simply joins it. Either way the log line carries the fact.

---

## Batch 3 — Private Company payout modal (T06 §4.3)

One component, four changes, one commit:

- **(a)** Player names printed in their player colour, no swatch.
- **(b)** Drop the rules line at the top — the modal appears when the rule fires.
- **(c)** Invert the sizing: the cash consequence (`$new > $old`) is the headline, the payout figure (`$15`) secondary.
- **(d)** "Also collected" rows expandable. Collapsed: name + cash consequence in the player stripe. Expanded: that entity's private holdings and each company's income. (Supersedes "full card per collector".)

---

## Batch 4 — corporation treasury slide-out (T06 §4.2) — feature

Gated on Batch 0's retest result.

- Drop the train-purchase toast; keep the depot-supply toast.
- Add a treasury slide-out for **any** corporation treasury adjustment, mirroring the player-cash slide-out.
- Position **top right, below the Action Bar** — not the bottom left, which is the player's corner.
- Same animation vocabulary, plus a **subtraction-merging** variant (the existing merge only sums).
- Sound: **undecided** — ship silent, decide after seeing it.

---

## Batch 4b — "Game Type" drop-down in the waiting room — feature (7 Sep)

Presentation only: the three fields already exist on `GameVariants` (#1300 `expandedMap`, #1310 `plusTiles`,
#1320 `levelPlayingField`, which forces the other two). `SetupGame` and every old log are untouched.

| Selection | `expandedMap` | `plusTiles` | `levelPlayingField` |
|---|---|---|---|
| 18XX | false | false | false |
| 18XX+ | true | checkbox **Expanded Tileset** (shown only here) | false |
| 18XX+: Level Playing Field | true | true (forced, checkbox hidden) | true |

Replace whatever toggles currently drive those three booleans in `SandboxWaitingRoom.tsx` with the
drop-down + conditional checkbox; `resolveVariants` still reads the booleans, so a room dealt from an older
build reads correctly.

## Batch 5 — legibility: `rem` scale (T06 §4.1)

"Everything is way too small"; one player at 250% browser zoom. Widest reach, widest blast radius, so it
goes **last** — every batch above gets visually checked once at the new scale rather than twice.

- Replace fixed `px` type/spacing with a `rem` scale off one root size so the browser's own accessibility
  zoom does what the player is reaching for.
- Test by emulating a smaller viewport and higher DPR, not by trusting one machine.
- Own commit, full visual pass of every screen after.

---

## Not in this plan — needs a ruling or belongs elsewhere

| Item | Why it is parked |
|---|---|
| Auto-Pass locked when a presidency can be taken (T05 20) | **Spec change** (`AutoPassModal.tsx`). Wants a ruling, not a patch. |
| Ctrl+Shift+L for every player, not host-only | Plan §6: belongs with Phase 3b (settlement evidence). Small if wanted early. |
| Auto-Buy graduation (presidency guard, sale wakes) | Labelled a debug tool (#1240); graduate only if it is staying. |
| Auto-skip flicker (T05 6) | Decided: granular log, settle-point emission. Server path already delivers a burst per frame. Re-observe, do not patch. |
| Everything in T06 §3 | Structural; not UI. |

---

## Status — end of 7 September session

Every batch below is written, `tsc` clean, and design-noted #1257–#1273. **The full suite has not been run**
(owner runs it). Pinned source-scan tests were re-anchored beside each change; the ones most likely to
object elsewhere are named.

| Batch | Note | What landed | Verify in a browser |
|---|---|---|---|
| 1.1 | #1257 | `VIEWPORT_RADIUS` token; every tab root squares its top corners | tab sits on its panel |
| 1.2 | #1258 | The Host hold renders as the waiting room itself; `waiting-room.jpg` preloaded from the lobby | no middle frame on Host |
| 1.3 | #1259 | Neta DAO hold 1600 → 1280ms | |
| 1.4 / 1.5 / 2.4 | #1260 | **Root cause found:** `mix-blend-mode` was on the video inside a fixed+z-index container (a stacking context), so it blended against nothing — the black box. Blend moved to the container. Unmuted `play()` rejection retries muted; nothing paints until `playing`. **Overlay renders on the Rail Map tab only**; a viewer switching to the map mid-clip joins it at the right offset | both clips key out on both seats; nothing on the Stock Market tab |
| 1.6 | #1261 | Third log tone `sign` (par-frame yellow) for any Yellow Sign stage line | |
| 1.7 | #1262 | Sibling cards recede during a mini-auction; every card-face control has a disabled look; file joins `disabledLook.test.ts` | |
| 1.8 | #1263 | **Root cause:** the tray sat under `boardPane`'s counter-zoom, drawn at 1/0.63 of the chrome. `traySlot` zooms back to chrome scale | tray + rose at panel size |
| 1.9 | #1264 | `YellowSignEvent`'s train comes out of the fleet diff before it reads as a limit discard (same shape as #1245) | no Train Limit modal on a Mark |
| 1.10 | #1265 | Tray tiles 64 → 84px, id body → strong, column min derived | |
| 1.11 | #1266 | **Root cause:** the photograph was `cover` on a content-height root; the notice line under Ready regrew it. Picture moved to a fixed `sceneLayer`; root isolates so the Neta mark still keys | no zoom on Ready / join / name |
| 2.1 | #1267 | Tokens splay horizontally, anchored to the cell's lower half; hover lifts clear of the row | price stays readable |
| 2.2 | #1268 | Slide is now `element.animate()` with both keyframes stated (the CSS transition's implicit "from" under `zoom` was the teleport); snap is `cancel()`. `MarketToken` forwards a ref | mini-chart moves one cell, no jump |
| 2.3 | #1269 | Whistle watches `turnAnnounceable` = my turn ∧ room `playing` ∧ no titles — so it fires when the titles clear, never over the waiting room | whistle at end of intro / on skip |
| 3 | #1270 | Rule line gone; cash movement is the largest type; "Also collected" rows are player stripes that expand to that player's privates. `PrivateRevenueRound.others[].rows` added | |
| 4 | #1272 | `TreasuryMoneyMachine` (top right, measured under `[data-action-bar]`, same schedule as the dividend machine, red subtraction merge, silent). Fed by `treasuryMovements(before, after)` on every dispatch. Buyer's train toast gone; depot line kept | every treasury move slides out; depot toast only at ≤2 left |
| 4b | #1271 | Game Type select (`gameTypeOf` / `withGameType` in `gameVariants.ts`); Expanded Tileset checkbox only under 18XX+ | |
| 5 | #1273 | **Not `rem`** — `typography.ts` #3 explains why a root font-size reaches nothing here, and the real cause is #1149's fixed 0.63 chrome zoom fitted to one monitor. `UI_SCALE` now resolves per browser (`utils/uiScale.ts`): stored choice, else a width-based default (0.63 at ≥1800px → 1.0 at ≤1200px). `− 100% +` picker in the TopBar; reloads on change | the 250% player picks a step and stops zooming |

**Batch 0** (retest #1237/#1238) is still owed and still yours — nothing here depends on it any more.

**Working tree:** all of this is uncommitted, alongside the migration work that was already uncommitted.
I did not commit, so the batches are not separated by commit; `git add -p` by design note number if you
want them apart.

**Tests most likely to need a look after the run:** `uiScale.test.ts` (rewritten pins), `batch52.test.ts`
(receipt gate), `marketCamera` / `marketPeek` (slide mechanism), `batch49` (payout modal), `blendIsolation`
(two new chains), `disabledLook` (new file on the roster), `variantWiring` (drop-down flags).

---

## Suggested order

```
0  retest #1237/#1238                       gates 4
1  quick wins (1.1–1.11)                    eleven small commits
2  cosmetic bugs (2.1–2.4)                  four commits; 2.4 wants a decision first
3  payout modal (a–d)                       one commit
4  treasury slide-out                       one commit, after 0
4b Game Type drop-down                      one commit
5  rem scale                                one commit, last, full visual pass
```
