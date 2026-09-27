# Batch 3 — Operating-corporation authority + station legality

Date: 2026-09-14. Baseline: `dca00bb` (Batch 2), 346 suites / 5317 tests, both typechecks clean, golden
replay green. Authority: `en_1830re_Rules_1830-RE_EN.pdf` (Lookout, 2018), §6.3.1–6.3.3. Not committed.

## 1. Files changed

| File | Change |
|---|---|
| `frontend/src/gameEngine/operatingIdentity.ts` | **new** — #1510 `operatingIdentityRefusal(state, msg)`: `LayTile`, `PlaceStationToken`, `RunMultipleRoutes`, `RunManualRoute` must name `operatingCorporationId(state)`; refused outside an Operating Round; **fails closed** on an unresolvable cursor inside one (see §3a). A state that names no round at all is "not said" (#232) and gets no opinion — that is the fixture case only. |
| `frontend/src/gameEngine/stationPlacementGate.ts` | **new** — #1511 `stationPlacementRefusal(state, placement, mapGrid)`: round, corporation exists and is floated, Tokens step, allowance, treasury vs schedule, then `evaluateStationPlacement` with `barredHexesFor` (#1323). Grid absent = board rules not asked (#757's "no opinion"). |
| `frontend/src/gameEngine/stationTokens.ts` | #1511 — `evaluateStationPlacement` judges the **circle** when one is named: `citySlotCount`, per-circle occupancy (`tokenCircleOf`, #698's bucket rule), and home reservations **locked to that circle** (`homeReservedCityIndex`, via #858's `homeSlotIndex` + `stationMarkerPoint` — the same reader the ring and the click use). Hex-level arms kept; a hex-level question on a multi-city hex now means "some circle may be taken". New exports `cityCountAt`, `homeReservedCityIndex`; `StationPlacementCompany.station_tokens?` added. `citySlotCount` (existing, shared with `cityBlocking`) now answers the bare yellow OO hexes (E11/D10/H18/E5) with one slot per circle instead of 0 — it had disagreed with `stationSlotCount`'s 2 for the same hex. |
| `frontend/src/gameEngine/sandboxSession.ts` | Both gates run in `applySandboxActionCore` before any arm, returning the state by identity (#778/#1019). Arm comment corrected. No arm logic changed. |
| `frontend/src/gameEngine/replayLog.ts` | `RoomEngine.apply`: the tile-grid atom refuses a `LayTile` the identity gate refuses (#757: a lay touches two atoms; they must agree). |
| `frontend/src/App.tsx` | Same fold into the shell's single `layRefused` predicate (the symbol `oneLayPerTurn.test.ts` pins as shared by both atoms). |
| `frontend/src/utils/replayJuno3XD.test.ts` | PRR's filed run re-pinned 210 → 170 with the reason (see §5). |
| `frontend/src/utils/operatingIdentity.test.ts` | **new** — 15 tests. |
| `frontend/src/utils/stationLegality.test.ts` | **new** — 28 tests. |
| `frontend/src/utils/cityTopology.test.ts` | **new** — 5 tests: the catalog's city *i* is the artwork's city *i* for every two-city tile at every orientation (see §4a). |
| `frontend/src/utils/__fixtures__/JUNO-FCJ-prefix96.log.jsonl` | **new** — first 96 entries (index 0–95) of the playtest log, frozen; 17 KB. |

Pre-existing and untouched: `frontend/src/utils/audio.ts` was already modified in the working tree before
this batch. `_to_delete/__scratch_fcj.test.ts` and `_to_delete/__probe_reach.test.ts` are throwaway replay
probes (the VM cannot delete). A scratch `git worktree` used to run the pre-fix engine could not be pruned
from the VM either: `git worktree prune` (or deleting `.git/worktrees/prefix`) on the host clears it.

## 2. Root cause of the B&M / NNH placement (JUNO-FCJ index 95)

Reconstructed by replaying the stored log through `RoomEngine` with the server's providers to index 94:
OR 7.1, order `[PRR, B&M, B&O]` @1 → **B&M operating, Tokens step** (identity was correct here); NNH
unfloated, reservation standing; G19 New York bare — two cities of one slot each; B&M's track reaches city 0
only. The recorded message: `PlaceStationToken{protocol_id:8, q:6, r:6, city_index:0}`.

Two faults, in series:

1. **The reservation model was hex-level.** `evaluateStationPlacement` counted NNH's home as "one slot held
   somewhere on the hex" (`occupied + unclaimedReservations >= slots` → `0 + 1 >= 2` → false → allowed).
   That arithmetic is right for an OO hex (E11/E5, "either circle", #43/#1283) and wrong for New York,
   where #858 already established — for the *home placement click* — that NNH's home is **locked to circle
   0**, the circle the badge is drawn in. The gate every *other* corporation's click goes through had never
   been told. The UI answered `allowed: true`, so the button was not even disabled.
2. **The reducer never asked.** The `PlaceStationToken` arm checked "not already on this hex" and charged.
   So even had the UI refused, a hand-built message would have landed.

**RETRACTED from the first draft of this note:** "Occupancy was also hex-level, which is why B&O (547), a
duplicate (551) and CPR (1058) later stacked into the same one-slot circle." That sentence was wrong. It came
from reading `PlaceStationToken` entries out of the raw log with `grep`, without the tile that stood on G19
at each index and without resolving `RevertTo`. The full reconstruction, on the **pre-fix** engine with the
server's providers, is:

| idx | corp | hex | tile on G19 before | cities / slots | targeted circle | occupants of that circle before | authoritative state after | renderer |
|---|---|---|---|---|---|---|---|---|
| 95 | B&M (8) | (6,6) G19 | none — printed New York | 2 cities × 1 slot | city 0 (NNH's locked home) | none; NNH reservation standing | B&M `station_tokens` += `[6,6,0]`, treasury 920→820 (LPF schedule $100) | city 0, printed circle 0 — **illegal** |
| 464 | NYC (2) | (6,6) | none | — | `LayTile 54@1`, `token_cities [[8,0]]` | — | tile 54 (green NY: 2 cities × 1 slot); B&M stays city 0 | B&M city 0 slot 0 |
| 531 | B&M (8) | (6,6) | 54@1 | — | `LayTile 883@3`, `token_cities [[8,0]]` | — | tile 883 (brown NY, #1315's merge: **1 city × 4 slots**) | B&M city 0 slot 0 |
| 547 | B&O (4) | (6,6) | 883@3 | — | city 0 | — | **not in the effective log**: undone by `RevertTo` at 548 | — |
| 551 | B&O (4) | (6,6) | 883@3 | 1 city × 4 slots | city 0 (the only city) | B&M | B&O += `[6,6,0]`, 476→376; `evaluateStationPlacement` (pre-fix, which on a one-city hex is the same question as post-fix) → **allowed** | city 0 slot 0 (B&O), B&M moves to slot 1 (bucket sorted by id) — distinct points |
| 935 | NNH (7) | (6,6) | 883@3 | 1 × 4 | `PlaceHomeStation` city 0 | B&O, B&M | NNH += `[6,6,0]`, free | slot 0 B&O, slot 1 NNH, slot 2 B&M |
| 1058 | CPR (3) | (6,6) | 883@3 | 1 × 4 | city 0 | B&O, NNH, B&M | CPR += `[6,6,0]`, 206→106; **allowed** (connectivity and room) | slots 0–3: CPR, B&O, NNH, B&M — four tokens, four slots, no overlap |

So: **one illegal placement in this game (index 95).** Every later New York token went into the brown tile's
single four-slot city, each in its own slot, and the renderer drew them at four distinct slot points. There
was no same-circle stack, and nothing about 551/935/1058 was a defect. (The residual effect of 95 is that
B&M holds a New York slot it should not have; CPR's fourth token at 1058 filled the city to capacity.)
Per-circle occupancy remains a **latent** model gap that #1511 closes — provable on a synthetic board
(`stationLegality.test.ts` "(2)") — but it produced no observed illegal state in JUNO-FCJ.

Neither fault depends on home-token timing. Under both the current float-time placement and the
rulebook's first-OR-turn placement the reservation stands at index 95, and the fix reads
`homeReservationStands` unchanged. **Timing is not touched** (audit M15 stays open).

## 3. Operating Round messages with client-controlled corporation identity

Traced: the engine's "who is operating" is `active_operating_order[active_corporation_index]` read through
`operatingCorporationId` (`dividendGate.ts`), a function of the log since #1196/#1197; the socket gate
(`turnAuthority`, #1205) checks only that the **sender** is the operating corporation's president.

| Message | Before | After |
|---|---|---|
| `LayTile` | `protocol_id` trusted | refused unless operating (**fixed**) |
| `PlaceStationToken` | trusted | refused unless operating (**fixed**) |
| `RunMultipleRoutes` | trusted | refused unless operating (**fixed**) |
| `RunManualRoute` (legacy, schema still admits it) | trusted | refused unless operating (**fixed**, same family) |
| `DeclareDividends`, `BuyHardwareFromPool`, `EmergencyBuyHardware`, `ExchangeTrainForDiesel`, `BuyKanawhaLicense` | already checked against the cursor | unchanged |

### 3a. The unresolvable-cursor case (fail closed)

Traced. `operatingCorporationId` is `null` when the round is not an OR, or when
`active_operating_order[active_corporation_index]` is `undefined` (empty queue, or an index past the end).
Inside an OR nothing else refuses these four messages before mutation: `turnRefusal` lets a `null`
`actingAddress` through ("an unresolvable cursor allows the action through"), `homeTokenBlock` is about home
tokens, and the arms check nothing. The first draft copied `dividendGate`'s fail-open position; that is wrong
for messages that act *for* a corporation and are derived by nothing, so the gate now refuses:
"No corporation is operating, so nothing may act for one." Live play never reaches it — an OR cannot open
without a floated corporation (Batch 1.1), `advanceCorporation` never leaves the index past the end (the
round ends by flag and transitions in the same action), and the empty-queue repair path is driven by
`PassTurn`, which is outside the family — so the refusal is recoverable by construction.
`operatingIdentity.test.ts` proves both shapes (empty queue; index past the end) refuse all four messages by
identity, and that a state with **no round field** still gets no opinion, which is what the isolated-arm
fixtures (`gameVariants.test.ts`) rely on. The dividend/train/licence gates keep their own position; changing
them is not this batch.

**Same defect, reported and NOT fixed here (scope):**
- `BuyPrivateCompany.protocol_id` — no operating check in the arm (audit M13 also lists phase/price/seller).
- `ProposePrivatePurchase` / `ProposeTrainPurchase.buyer_protocol_id` — socket checks the buyer's president
  (#1450), nothing checks the buyer is the operating corporation; a president of two corporations can
  offer on behalf of the idle one. The derived settlement then binds to that offer.
- `BuyTrainFromCorporation` — bound to an open offer, so only reachable through the above.
- `AdvanceOperatingSubPhase.protocol_id` — ignored by the arm (cursor-driven); harmless.
- `YellowSignEvent` — client-authoritative; excluded by instruction.
- `PlaceHomeStation` — owner-checked at the socket; the arm validates neither the hex (single-home
  corporations, M15) nor the circle against occupancy/#858's lock. Home-token territory; documented only.

## 4. Station-legality rules that were UI-only, now authoritative

All of `evaluateStationPlacement` (audit M6) plus the two `stationPlacementBlockReason` arms:
slot exists (and the named circle exists); circle occupancy (was hex-level); one token per corporation per
city; home reservation held against others — locked circle on New York, either-circle on OO hexes;
connectivity through a walled board (#1006) with the Coal River bar (#1323); allowance
(`station_token_limit`); treasury vs the schedule in effect (`adjustTreasury` clamped at zero and placed
anyway); the Tokens step (= one token per turn, #774's reasoning); floated. Herald homes (#1302) and the
D&H free token (`PlaceHomeStation{kind:"dh"}`) are on other paths and unaffected (`heraldHome`,
`dhTokenStep` green).

### 4a. Hex → city → slot: the model the gate consumes

Audited before commit, because the project's history is full of the three being conflated.

| Layer | Canonical city identity | Slots |
|---|---|---|
| Tile catalog (`hexTileCatalog.ts`) | `cityGroups[i]` = the edges of city *i* (base rotation); `tileCityEdges` rotates | — |
| Tile artwork (`TileGraphics.ts`) | `markers` of kind `city`, **in the same index order as `cityGroups`** (documented on `TileArtwork`); `tileCitySlotCounts(id)[i]`, `tileCitySlotPoints(id, i, …)` | `marker.slots` (default 1) |
| Printed hexes | `printedMarkersFor(label)` city markers in order; G19 = `NEW_YORK_PRINTED_ARTWORK.markers` (2); landmarks' `LANDMARK_TRACKS[name][i].edges` | `marker.slots` (1830+'s Montreal/Norfolk pills) |
| Station-token state | `station_token_hexes: [q, r]` (hex) + `station_tokens: [q, r, city_index]` (#560/#134); a token with no recorded circle is bucket 0 (#698) | none — "a slot has no meaning in the rules" (#134); slot order is the renderer's, by company id |
| Placement UI | `cityIndexAtPoint` / `cityNodePoints` (city-index order); `homeSlotIndex` for the locked home circle (#858) | `nextCitySlotPoint` for the preview |
| Route walk (`trackReach.ts`) | `cityForArrival(q, r, edge)` → index via `cityExitEdges` (= `cityGroups`/`LANDMARK_TRACKS`); `reachableCities` keys `"q,r:i"` | — |
| Blocking (`cityBlocking.ts`) | `(q, r, cityIndex)` with `slotsAt = citySlotCount`, `cityOf = tokenCityIndex` | `citySlotCount` |
| Upgrades (`LayTile` arm) | `token_cities [[companyId, cityIndex]]` from the shell's plan; #1315 clamps to the new tile's city count (62→883 merge) | — |
| **`stationPlacementGate` / `evaluateStationPlacement`** | `cityCountAt` (from the same tables), `citySlotCount`, `tokenCircleOf` (= `tokenCityBucket`), `homeReservedCityIndex` (= `homeSlotIndex` over `cityNodePoints`/`stationMarkerPoint`), connectivity via `reachableCities` + `cityBlockerFor` | `citySlotCount` |

They agree — and now a test says so rather than a comment: `cityTopology.test.ts` walks every two-city tile
in the catalog at every orientation and checks that the circle drawn for city *i* lies on a rail whose edges
`tileCityEdges` assigns to city *i*, that the city count matches, and that printed New York's edge 1/edge 4
arrivals land on the circles drawn there. A pill (J14 tile 14, brown New York #883) is one city in every
table — one `reachableCities` key, one `cityCountAt`, *n* slots — and `stationLegality.test.ts` "(3) and (4)"
pins that. No second model was written for the gate; the one divergence of convention is recorded: for a
token with **no recorded circle on a two-city hex** the blocker refuses to guess (a wrong wall is invisible,
#134) while the gate, like the renderer and the preview, buckets it to city 0 (a wrong refusal is visible).
Both are the existing conventions of their layers; only pre-#560 logs can produce such a token.

The five requested cases: (1) occupant in city 0 does not consume city 1 — `stationLegality` "(1)" on tile 59,
and the locked-reservation form on printed New York; (2) city 0 occupied refuses city 0 while city 1 is empty
— "(2)", plus the FCJ synthetic (NNH in circle 0); (3) two corporations in two slots of one city — "still allows
the second SLOT of J14's one city" and, historically, FCJ 551/935/1058 above; (4) a pill stays one city for the
walk and the wall — "(3) and (4)" plus the standing `stationTokenWall.test.ts` "rule 1" pair and
`cityBlocking.test.ts`; (5) upgrade keeps identities — "(5)" (tile 59 → 64 through the reducer with
`token_cities`) plus the standing `nyMerge.test.ts` (62 → 883 merge) and `tileUpgrades.test.ts`.

## 5. Tests run (targeted) and results

- New: `operatingIdentity.test.ts` 15/15, `stationLegality.test.ts` 28/28, `cityTopology.test.ts` 5/5.
  Negative controls: the old hex arithmetic asserted to answer "allowed"; the arm shown to apply the same
  B&M run when the gate's precondition (a stated round) is removed; the live entry 95 applied through
  `RoomEngine` leaves `stateDigest` unchanged.
- Existing, all green after the final edits: `replayGolden` (3 frozen logs), `replayJunoCV4`, `replayJuno3XD`
  (after re-pin), `cityBlocking`, `stationConnectivity`, `routeCityBlocking`, `cityScopeCoverage`, `plusTiles`,
  and 36 reducer/station/room suites: atomicRunRoutes, batch20/40/45/60, bonusLayStep, gameVariants,
  layAuthority, levelPlayingFieldRules, markKeepsRun, multiTrainRun, nyMerge, oneLayPerTurn,
  refusedAction, routeRevenueReset, terrainAffordability, terrainFeeOnce, visitOnce, stationTokenWall,
  stationCityReach, stationVeil, derivedActions, dhTokenStep, heraldHome, homeReservationClears,
  homeSlotChoice, homeTokenGate, tokenSpendNote, atomicReducer, auctionSeating, divergenceWatch,
  drainReadsFreshState, messageSchema, roomSession, rulesScope, turnAuthority.
- Both typechecks clean (`frontend` `tsc --noEmit`; `server` `tsc -p` to a scratch outDir, no
  `require("react")`).
- Replay sweep of every stored log with the fix (digest-compared per entry): JUNO-CV4, Z6C, G6J, 7NZ —
  no new refusals. **JUNO-CW7 index 101**: B&M into NNH's New York home again, now refused. **JUNO-3XD
  index 224**: C&O laid E13 while the log-derived queue had PRR operating (the #1196 client divergence; the
  engine already refused C&O's train purchases at 228/229 on that cursor) — now refused on both atoms, so
  PRR's run at 307 (E11–E13–F14…) files 170 not 210; re-pinned per #1195's own instruction. **JUNO-FCJ**
  diverges from index 95 onward by construction (the rest of that game was played on the illegal token),
  which is why only its prefix is frozen.

**Expected full-suite totals: 349 suites / 5365 tests** (+3 suites, +48 tests over the 346 / 5317 baseline;
no test removed). The owner's run of the previous draft was 348 / 5352.

Full suite: `cd frontend && npm test -- --watchAll=false` (or `frontend\test-summary.ps1`), plus
`npm run typecheck` in `frontend/` and `npm run build` in `server/`.

## 6. Replay compatibility — the consequence of the 3XD re-pin, recorded

- **Yes: a room dealt under the old behaviour and rebuilt after this deployment produces the corrected
  state, not its historically observed one.** `RoomSession.restore` → `rebuild()` → `RoomEngine.apply` over
  `effectiveActions(log)` — the identical path, seed (`sandboxScenarioState(DEFAULT, 0, "default")`) and
  providers (`sandboxReplayProviders()`) that `replayJuno3XD.test.ts` and `replayGolden.test.ts` use
  (`gameServer.ts` `roomFor`). `replayJuno3XD` is not merely a development corpus: it exercises the mechanism
  that governs every server restart, every `RevertTo` (#1233 rebuilds), and every reconnecting client's drain.
- **The only pin is the build id, and today it is nominal.** #1252 records `SetupGame.build` in the deal and
  the server refuses to continue a room whose deal names another build. But the build id is
  `process.env.BUILD_ID ?? --build ?? "dev"`, and every stored log (FCJ, CV4, …) was dealt as `"dev"` by a
  `"dev"` server. So unless a deploy sets `BUILD_ID`, a Batch 3 server will reopen a Batch 2 room and rebuild
  it under Batch 3 rules. There is no rules version in the log itself; **reducer changes apply retroactively
  to replay.** Client and server stay consistent with each other (both replay the same log with the same
  reducer), but the board can differ from what the table saw — 3XD's PRR run (210 → 170) and FCJ from index
  95 onward are the two known instances. Setting `BUILD_ID` per deploy would make #1252's pin real; that is
  not built here.

## 7. Observations, not acted on

- A reducer refusal is an identity no-op; `RoomSession.submit` still answers `applied` and appends the
  entry (it replays as a no-op). Batch 2 kept this shape deliberately; a `refused` answer keyed on
  `stateDigest(before) === stateDigest(after)` would be the transport-level follow-up.
- `actionWasRefused` (#778) compares by identity, but the chart step (#1197) returns a new object for every
  state carrying `market_positions`, so the shell's REFUSED receipt cannot fire in room play. Pre-existing.
- `evaluateStationPlacement` now imports `homeSlotIndex`/`stationMarkerPoint` from
  `components/hexCanvasPrimitives.ts` (pure TS, canvas objects only inside functions; already in the server
  build). One more entry for Batch 1 §6a.
