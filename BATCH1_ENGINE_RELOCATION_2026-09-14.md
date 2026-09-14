# Batch 1 — Engine relocation (architecture only) — 2026-09-14

**Scope:** move the authoritative TypeScript game machine out of `frontend/src/utils/` into a clearly
engine-owned directory, and close every path by which it reached React. **No gameplay rule behaviour was
changed.** No audit finding was fixed. Nothing in `AUDIT_RULES_TO_MACHINE_2026-09-13.md` was acted on.

Baseline commit: `9520866c11282d2539bab96b276d0d4c1ae62eb6`, working tree clean.

---

## 1. Canonical validation

There is one Jest configuration in the repository — CRA's, via `react-app-rewired`, rooted at
`frontend/src`. `server/` has no test runner; it is validated by its own `tsc` project plus the headless
smoke test. The Rust crate was not touched by this batch and was not run.

| # | Command | Covers |
|---|---|---|
| 1 | `npm test -- --watchAll=false --listTests` (in `frontend/`) | which files Jest collects |
| 2 | `frontend\test-summary.ps1` | the suite, including the golden-replay master |
| 3 | `npm run typecheck` (root) | `tsc --noEmit` over `frontend/src` |
| 4 | `npm run build` (root) | the production build Vercel runs |
| 5 | `npm run build` (in `server/`) | a **second, independent** `tsc` project — compiles `server/src` plus everything it reaches through `../../frontend/src/...`. Step 3 does not cover it. |
| 6 | `npm run smoke` (in `server/`) | `RoomSession` → `RoomEngine` → reducer, end to end, no browser |

Replay compatibility is covered by step 2: `replayGolden.test.ts` replays every frozen log in
`__fixtures__/replayGolden/logs/` and compares the final board to a fixture written before the atomic-reducer
refactor.

`run-baseline.ps1` (in `Documents\18Cosmos_Juno\baseline`, outside the repo) runs all six in one window and
tags its logs `-before` / `-after`.

## 2. Before and after

| Check | Before | After |
|---|---|---|
| Test files discovered | 344 | **344 — byte-identical list** |
| Test suites | 344 passed / 344 | 344 passed / 344 |
| Tests | 5285 passed / 5285 | 5285 passed / 5285 |
| Failed / skipped / todo | 0 / 0 / 0 | 0 / 0 / 0 |
| `npm run typecheck` | exit 0 | exit 0 |
| `npm run build` | succeeded, 39 warnings | succeeded, **39 warnings** |
| bundle | `main.1b1ca467.js`, 1.09 MB | `main.1b1ca467.js`, 1.09 MB, no size delta |
| server `npm run build` | exit 0 | exit 0 |
| server `npm run smoke` | 27 ok, 5 FAIL, `SMOKE FAILED` | 27 ok, **the same 5 FAIL**, `SMOKE FAILED` |
| `require("react")` in the compiled server graph | **6 files** | **0** |

The test count is unchanged for a structural reason rather than a lucky one: **no test file moved**, and
Jest's `roots` were not touched. The discovered-file list was diffed before and after and is identical.

**The five smoke failures are pre-existing.** They were failing at the baseline commit, they fail identically
now, and they are all lobby/chat roster assertions (`{ kind: 'chat', room: 'LOBBY', messages: [] }`) —
transport, not game rules. This batch neither caused nor fixed them.

## 3. New architecture

**Old:** `frontend/src/utils/` — the reducer and its rule modules interleaved with toasts, audio, gestures,
UI scale, lobby transport and narration, with no way for a reader to tell which was which.

**New:** `frontend/src/gameEngine/` — 60 files. `index.ts` is the server's entry surface.

### Why not a repo-root `shared/` package

That is where this belongs, and it is a later infrastructure batch. Reaching it requires patching CRA's
`ModuleScopePlugin` (which refuses any import outside `frontend/src`), babel-loader's `include` (files
outside `appSrc` are not transpiled), `frontend/tsconfig.json`'s `include`, and the `src`-relative reader in
`sourceScan.ts` that **137 files** use to scan source off disk. That is build-system work with its own risk,
and it has no business riding along with a file move whose entire claim is that nothing changed. The engine
is a sibling of `components/` and `utils/`, not a child of either; the server imports it directly.

### What moved (57 files, `git mv`, recorded as R100 renames)

Reducer and replay — `sandboxSession.ts`, `sandboxState.ts`, `replayLog.ts` (`RoomEngine`),
`replayProviders.ts`, `logRevert.ts`, `logHash.ts`, `stateDigest.ts`, `sha256.ts`, `derivedActions.ts`,
`initialGrid.ts`, `boardSelection.ts`, `mockFixtures.ts`.

State, setup and phase — `gameState.ts`, `gameSetup.ts`, `gameConstants.ts`, `gameVariants.ts`,
`gamePhase.ts`.

Stock market and shares — `sharePurchase.ts`, `shareSale.ts`, `soldOutRise.ts`, `marketStack.ts`,
`doubleCertificate.ts`, `presidencyTransfer.ts`, `forcedDivestment.ts`, `floatThreshold.ts`.

Auction — `auctionEscrow.ts`.

Operating round — `operatingCursor.ts`, `dividendGate.ts`, `dividendSplit.ts`, `earnableRevenue.ts`,
`bonusLay.ts`, `terrainFee.ts`, `stationTokens.ts`, `homeTokenGate.ts`, `turnAction.ts`, `turnAuthority.ts`,
`turnGuardKey.ts`, `autoSkipExit.ts`.

Trains and phases — `depotSchedule.ts`, `trainLimit.ts`, `trainPurchaseGate.ts`, `trainReach.ts`,
`trainPhrasing.ts`, `dieselExchange.ts`.

Track and routes — `trackReach.ts`, `trackSegments.ts`, `routeAutoTrace.ts`, `cityBlocking.ts`,
`cityBypass.ts`.

Private companies — `privateExchange.ts`, `privateOrdinal.ts`, `privateReservations.ts`,
`baltimorePrivate.ts`, `dhPower.ts`, `kanawhaLicense.ts`, `levelPlayingField.ts`, `yellowSign.ts`.

Game end — `endgame.ts`.

### Files created

| File | Why |
|---|---|
| `gameEngine/index.ts` | the server's entry surface (§5) |
| `gameEngine/marketGeometry.ts` | #1501 — the chart's rules, lifted out of `StockMarketRenderer.tsx` |
| `gameEngine/operatingSubPhase.ts` | #1502 — the OR sub-phase rules, lifted out of `OperatingSubPhaseStepper.tsx` |
| `utils/gameStatePolling.ts` | #1500 — the four React polling hooks, split out of `gameState.ts` |

### Intentionally left behind

- **All 344 test files.** Moving engine tests would mean extending Jest's roots and classifying ~304
  `utils/` suites, many of which (`batch20`–`batch64`) test engine and UI together. Deferred; the engine's
  tests living in `utils/` is a real wart and belongs in its own batch.
- **`roomSession.ts`, `serverProtocol.ts`, `lobbyProtocol.ts`, `sandboxRoom.ts`, `sandboxRoomSummary.ts`,
  `roomDocLink.ts`, `seatPin.ts`, `presence.ts`, `sessionKey.ts`** — room, lobby and transport. Left where
  they are on instruction: these are server concerns, not the game machine.
- **The board/tile/chart data cluster in `components/`** — see §6.

## 4. Dependency boundary

**The engine imports no React, touches no DOM or browser global, and holds no client networking.** Proved
three ways: no `from "react"` anywhere under `gameEngine/`; no `document`/`window`/`localStorage`/
`navigator`/`WebSocket`/`fetch` in engine code (the three `window` hits are the English word in prose); and a
clean compile of the server to an empty output directory contains **zero** `require("react")`, against six
before.

Three paths reached React and all three are closed. Each was an **extract-and-re-export**: the pure half
moved to the engine, the React file imports back what it draws with and re-exports every symbol, so no
importer in the app or the tests moved.

| Was | Is | Note |
|---|---|---|
| `gameState.ts` held the state schema *and* four `use*Polling` hooks, so `import { GameStateResponse }` pulled `react` into the importer's graph | hooks + `QueryCapableClient` → `utils/gameStatePolling.ts`; types and pure derivations stay in the engine | #1500. Named by #1200 as the thing `replayCli` discovered and did not fix |
| `replayProviders.ts` → `StockMarketRenderer.tsx` for the ladder's geometry | geometry → `gameEngine/marketGeometry.ts`; the renderer re-exports it | #1501. #1199 asked for exactly this and declined to do it; that note is updated to record it is done |
| `operatingCursor.ts` → `OperatingSubPhaseStepper.tsx` for the step rules | rules → `gameEngine/operatingSubPhase.ts`; the strip re-exports them | #1502. #656 said the cursor is game state; the rules it reasons with were still in a component |

Plus one type-only path: `mockFixtures.ts` imported `MapGridResponse` and `MarketGridResponse` from two
React components that merely re-export them. Repointed at the modules that declare them.

Four constants were module-private in `StockMarketRenderer.tsx` and the renderer still draws with them, so
the split had to export them: `MARKET_MIN_X`, `MARKET_MAX_X`, `MARKET_MIN_Y`, `clamp`. They are not on the
engine's public surface. One merged comment block in `gameState.ts` documented a hook and a type at once and
had to be split so each half stayed with what it describes.

**No compatibility re-exports were created in either direction for the reducer.** The server imports
`frontend/src/gameEngine` directly. `frontend/src/utils/` contains no shim pointing at the engine — every
consumer was repointed (733 specifier rewrites across 254 files). The re-exports that do exist are the three
UI files above re-exporting engine symbols, which is the opposite direction and is the point of the pattern:
the rules live in the engine and the shell borrows them.

## 5. Engine entry point

`gameEngine/index.ts` exports the server's surface and nothing else: the state types, room setup, the
reducer and the log that drives it, the providers, and the derivations a host needs (`derivePhase`,
`stateDigest`, `fieldDigests`, `logHash`, `turnRefusal`, `effectiveActions`). The rules modules —
`sharePurchase`, `dividendGate`, `trainLimit`, `routeAutoTrace` and the rest — stay internal.

The UI still imports deep, on purpose. Funnelling 200 component and test files through one barrel would be
churn with no reader served, and the direction of travel is the other way: fewer UI callers asking the
engine for rule answers, not more.

## 6. Deferred — rule logic still on the wrong side of the boundary

### 6a. The board / tile / chart cluster in `components/`

Fourteen modules, ~7,100 lines, all pure TypeScript with no React in them. The engine imports them upward.

| Module | What the engine takes | Engine modules depending on it |
|---|---|---|
| `hexContractTypes.ts` | `MapGridResponse`, `MapTileEntry`, `homeHexesFor`, `stationHomeHexes`, `homeReservationStands`, `tokenCityIndex`, `stationTickerLabel` | 12 |
| `hexBoardData.ts` | `STATIC_BOARD_HEXES`, `boardInEffect`, `boardMemo`, `heraldHexFor`, `LANDMARK_HEXES`, `YELLOW_OO_HEXES`, `STANDARD_BOARD` | 10 |
| `hexTileCatalog.ts` | `TILE_CATALOG_BY_ID`, `TileColorTier` | 5 |
| `hexGeometry.ts` | `archetypeForHex`, `hexValueForEra`, `cityExitEdges`, `liveEdgesForHex`, `evaluateHexForTileLaying`, `twoNodePositions` | 5 |
| `TileGraphics.ts` | `tileCitySlotCounts`, `printedPathsForTraversal`, `tileArtworkEdgePairs`, … | 2 |
| `marketChart.ts` | `PRICE_GRID`, `PAR_VALUE_LADDER`, `cellAt`, `chartFor`, `PriceCell`, `ZoneType` | 2 |
| `hexBoardDataLpf.ts` | `LPF_BOARD`, `COAL_RIVER_EDGES`, `NW_COMPANY_ID`, `PMQ_COMPANY_ID` | 3 |
| `hexBoardDataPlus.ts`, `tileTray.ts`, `tileTrayLpf.ts`, `tileTrayPlus.ts` | board and tray definitions | 1 each |
| **`sandboxTileLegality.ts`** | `filterSandboxPlacements` — **tile-lay legality** | 1 (`replayProviders`, as the injected `layRefused`) |

**Why the engine will need them:** they are the board. Tile legality, hex value by era, city exit edges and
the price ladder are rules, not decoration; the reducer already reads most of them directly.

**What prevents clean use:** design note **#273 — "`utils/` may not import `components/`"**. The rule was
only ever half-enforced: the board tables were imported directly in defiance of it, while the chart and the
legality engine were honoured by **injecting them through `SandboxActionContext`** instead. That injection
is the mechanism the audit found route/station/tile legality "trapped" behind, because a caller that omits
an injection gets *no rule* rather than an error.

**Recommended destination:** `frontend/src/gameEngine/board/`, moved wholesale with the legality batch.

> **Worth knowing before that batch.** #1501 has already retired the justification for four of those
> injection points. `projectRise`, `marketZoneFor`, `zoneForPrice` and `parCellFor` are all optional
> `SandboxActionContext` fields whose notes say they are injected *because* `utils/` may not import the
> chart. The chart's rules are now in `gameEngine/marketGeometry.ts` and the reducer can import them
> directly. `homeHexToAxial` is in the same position and was already redundant, since the reducer imports
> `homeHexesFor` from `hexContractTypes` anyway. **Deliberately not acted on here** — collapsing an
> injection changes what happens when a caller omits it, which is a behaviour change. `layRefused` remains
> genuinely justified until `sandboxTileLegality.ts` moves.

### 6b. Route validation, in `utils/`, reachable only from the UI

The audit's C2 ("routes are priced but never validated") depends on these. They are on the right side of the
`components/` boundary but on the wrong side of the engine boundary, and nothing in the reducer imports any
of them.

| Module | Lines | Imported by |
|---|---|---|
| `runTrainsRules.ts` | 115 | `App.tsx` and its own test only |
| `routeConnection.ts` | 169 | `routeDraftEdit.ts` and one test |
| `routeWaypoints.ts` | 279 | route drafting |
| `routeStep.ts`, `routeTruncate.ts`, `routeDraftEdit.ts` | 400 | route drafting |
| `stationConnectivity.ts` | 130 | `tokenMigration.ts`, two tests |
| `tileUpgrades.ts`, `tileSupply.ts` | 347 | `App.tsx`, tile pickers |

**Recommended destination:** `gameEngine/routes/`, together with the C2 refusal work — the move and the
wiring are the same job, and doing the move alone would leave dead code in the engine.

### 6c. Station placement

`evaluateStationPlacement` moved into the engine with `stationTokens.ts` and is now importable by the
reducer. It still isn't *called* by it — `App.tsx` calls it before dispatch. That is a wiring gap for the
audit's station batch, not a location problem any more.

### 6d. Test ownership

All 304 engine-adjacent suites remain in `frontend/src/utils/`. Splitting them needs a Jest `roots` change
and per-suite classification.

## 7. Behaviour

**No gameplay rule behaviour was intentionally changed in this batch, and nothing unexpectedly changed.**

Evidence beyond the suite:

- Of the 57 moved modules, **none has a non-import content change**. Diffed against `HEAD` line by line;
  the only content edits anywhere in the engine are in `gameState.ts` (the hook split) and
  `mockFixtures.ts` (two type imports repointed).
- `replayGolden.test.ts` passes — every frozen log replays to the same final board, compared against a
  fixture written before this batch.
- The server smoke test produces the same 27 `ok` lines and the same 5 failures, in the same order.
- The production bundle has the same name, hash and size, with the same 39 ESLint warnings.
- Message formats, serialized log-entry formats and state schema are untouched. `ServerLogEntry`,
  `ReplayEntry`, `ExportedEntry`, `GameplayExecuteMsg` and `GameStateResponse` keep their shapes and their
  modules; only import paths changed.

### Test changes forced by the move, listed in full

Relocation changes where a file is, and this repository's tests read files off disk — 137 of them. Each
change below is a path or a needle, never an assertion about the game.

| File | Change |
|---|---|
| 72 path literals across 50 files | `readStripped("utils/X.ts")` → `"gameEngine/X.ts"` |
| 12 `__dirname` reads across 11 files | repointed at `../gameEngine/` |
| `cityScopeCoverage.test.ts` | its `read()` helper served three tracers, two of which moved; the directory moved to each call site |
| `turnAuthority.test.ts` | `require("path").join(__dirname, "gameSetup.ts")` repointed |
| `presence.test.ts` | call site repointed, **and the needle widened** from `"./presence"` to `"utils/presence"` — the old spelling could no longer occur, so the guard would have passed forever without guarding (#886) |
| `batch60.test.ts` | sliced `StockMarketRenderer.tsx` for `projectBloodPriceMove`, now in `marketGeometry.ts` |
| `marketCamera.test.ts` | asserted `enteredAt?: number;` in the renderer; the field belongs to `MarketPositionEntry`, which moved |
| `autoBuy.test.ts`, `batch64.test.ts`, `routeCityBlocking.test.ts` | assertions that pin an import specifier, updated to the specifier the target file now carries |

That last row is worth flagging as a hazard for future moves: a mechanical specifier rewriter will also
rewrite path strings **inside test assertions**, where the correct answer depends on which file the
assertion is about, not which file contains it. Three occurrences; two were rewritten wrongly and are
corrected, one happened to be right. Every rewritten specifier was audited for this.
