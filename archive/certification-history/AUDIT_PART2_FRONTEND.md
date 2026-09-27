# 18Cosmos System Audit — Part 2: React/TypeScript Frontend (`frontend/src/`)

**Scope:** all 20 source files under `frontend/src/` (21,696 LOC).
**Mode:** READ-ONLY. No files modified.
**Auditor posture:** Lead Frontend Engineer + 1830 Tournament Rules Judge.

---

## 1. Status Matrix — Frontend Modules 1–4

| # | Module | Status | Worst gap |
|---|---|---|---|
| 1 | Consolidated "Stock & Auction" Tab & Action Controls | **Fully Implemented** | 🟡 Sell bundle capped at 40% |
| 2 | Header & Quick-Chat Ticker Bar | **Fully Implemented** | 🟡 Dead `FeedOverlay.tsx` left in tree |
| 3 | Rail Map Canvas & Pathfinder Visuals | **Partially Implemented / Gap** | 🔴 No route overlay at all |
| 4 | Web3 / Keplr Connection Hooks | **Partially Implemented / Gap** | 🔴 No `$JUNO` balance; placeholder fee-granter |

### Sub-item detail

| Checklist item | Status | Evidence |
|---|---|---|
| **1.** Waterfall panel: private cards/rows | ✅ | `WaterfallAuctionDashboard.tsx:373-391` |
| **1.** $5 min raise buttons | ✅ | `:166` `highBid + 5`; `:173` mini-auction `high_bid + 5` |
| **1.** Bid / Pass buttons | ✅ | `onBuyLowest`/`onBidHigher`/`onPass` + mini-auction raise/pass |
| **1.** Cash escrow locking indicators | ✅ | `:389-391` `🔒 {amount} VGP escrowed` badge |
| **1.** Par value grid $67–$100 | ✅ | `StockRoundPanel.tsx:84` — exact 6-value ladder |
| **1.** Buy share IPO vs. Pool | ✅ | `source: "Ipo" \| "Bank"` toggle |
| **1.** Multi-sell bundle selector | ⚠️ | `:87` capped at `[10,20,30,40]` — cannot sell 50%+ |
| **1.** 60% float indicator | ✅ | `:148-163` bar + threshold marker + `FLOATED` badge |
| **1.** Auto-tab switcher | ✅ | `App.tsx:1246-1259`, ref-guarded on genuine transitions only |
| **2.** Docked below tabs, no dark gaps | ✅ | `TopTicker` `#1E293B` = tab-bar color; renders directly after `MainTabBar` |
| **2.** In-place accordion, ~7 lines | ✅ | `TopTicker.tsx:66` `HISTORY_LINE_COUNT = 7`; no modal |
| **2.** Inline quick-chat input below ticker | ✅ | `InlineQuickChat` mounted directly after `TopTicker`, always mounted |
| **2.** Filter pills right of chat input | ✅ | `InlineQuickChat.tsx:88-105`, `marginLeft:"auto"` divider pushes right |
| **2.** Mandatory turn alerts (title flash + pulse) | ✅ | `turnAlert.ts` + `app-turn-pulse-glow`; opt-outs removed |
| **3.** Hex grid full-width viewport | ✅ | `ResizeObserver`-driven flex-fill, `:5864` |
| **3.** Multi-train track spline bezier rendering | ❌ | **No route layer exists** (see F-1) |
| **3.** Station token badge display | ✅ | `drawStationTokenMarker`, `:6487` |
| **3.** Tile placement preview overlays | ✅ | `previewTile` prop + `TilePreviewThumbnail` |
| **3.** Terrain cost badges $20 River / $80 Mountain | ❌ | Renders **$80 / $120** (see F-2) |
| **4.** Wallet detection | ✅ | `WalletContext.tsx:135-143`, `keplr_keystorechange` listener |
| **4.** `$JUNO` native balance querying | ❌ | **Does not exist anywhere** (see F-3) |
| **4.** `x/authz` session key authorization | ✅ | `MsgGrant`/`MsgExec`/`MsgRevoke` registered and wired |

---

## 2. Codebase Tile Manifest Table

**Source of truth:** `src/hexmap.rs:972` `TILE_CATALOG`.

> ⚠️ **`src/tiles.rs` does not exist.** The scope directive names it, but the tile catalog lives in `src/hexmap.rs`. There is also **no tile definition table anywhere in `frontend/src/`** — `TileSelectionPopup.tsx` renders only what `GetLegalTilePlacements` returns, and `HexGridRenderer.tsx` draws geometry from the `connections` bitmask on each `MapGridResponse` tile. That is architecturally correct (single source of truth, no drift), so the manifest below is backend-only by design.

**Catalog tuple arity is 5:** `(tile_id, connections, cost, TerrainType, TileColor)`. **There is no quantity field.** Every tile is therefore unlimited.

| Tile # (internal `tile_id`) | Real 1830 tray # | Color | Live Edges | Starting Qty Limit in Code | Depletion Counter Active? | Restrictive Tag |
|---|---|---|---|---|---|---|
| 1 | #7/#8-class | Yellow | 0,3 | **∞ (no field)** | ❌ None | Plain |
| 2 | #8-class | Yellow | 0,2 | **∞** | ❌ None | Plain |
| 3 | #3-class | Yellow | 1,3 | **∞** | ❌ None | Plain (SmallTown) |
| 6 | #55/#56-class | Yellow | 1,3 | **∞** | ❌ None | Plain (DoubleTown) |
| 4 | — (invented) | Yellow | 1,4 | **∞** | ❌ None | Plain (River artwork) |
| 5 | — (invented) | Yellow | 2,4 | **∞** | ❌ None | Plain (Mountain artwork) |
| 10 | #57-class | Yellow | 0,1,2,3,4,5 | **∞** | ❌ None | MajorCityHub |
| 11 | #9-class | Green | 0,3 | **∞** | ❌ None | Plain |
| 12 | #12-class | Green | 1,2,4 | **∞** | ❌ None | Plain (Mountain) |
| 13 | #14/#15-class | Green | 0,1,2,3,4,5 | **∞** | ❌ None | MajorCityHub |
| **15** | **#59** | Green | 0,2 | **∞** | ❌ None | **"OO"** |
| **16** | **#53** | Green | 0,2,4 | **∞** | ❌ None | **"B"** |
| **17** | **#54** | Green | 0,1,2,3 | **∞** | ❌ None | **"NY"** |
| 14 | #63-class | Brown | 0,1,2,3,4,5 | **∞** | ❌ None | MajorCityHub |
| **18** | **#61** | Brown | 0,2,3,4 | **∞** | ❌ None | **"B"** |
| **19** | **#62** | Brown | 0,1,2,3 | **∞** | ❌ None | **"NY"** |
| **20** | **#64** | Brown | 0,2,3,4 | **∞** | ❌ None | **"OO"** |
| **21** | **#65** | Brown | 0,2,3,4 | **∞** | ❌ None | **"OO"** |
| **22** | **#66** | Brown | 0,1,2,3 | **∞** | ❌ None | **"OO"** |
| **23** | **#67** | Brown | 0,2,3,4 | **∞** | ❌ None | **"OO"** |
| **24** | **#68** | Brown | 0,1,3,4 | **∞** | ❌ None | **"OO"** |

**21 catalog entries. 0 have a quantity. 0 have depletion enforcement.**

### Manifest findings

1. **Depletion status is uniformly "not enforced."** Confirms Part 1's G-5 from the opposite direction: no `remaining_tiles` map, no quantity field, no decrement in `execute_lay_tile`, no `qty == 0` rejection in `legal_tile_placements`. The tray is infinite in both layers.

2. **Internal IDs ≠ tray numbers.** The `Real 1830 tray #` column is reconstructed from `TILE_CATALOG`'s own inline `tobymao/18xx` citations, not from any machine-readable field. Nothing in the code or the wire format exposes a tray number — `GetLegalTilePlacements` returns internal IDs, so the tile carousel shows a player "Tile 16" when the physical game calls it **#53**.

3. **The restricted set is complete and correctly tagged.** All ten label-restricted tiles the scope directive names are present with the right colour tier and the right tag. The Green "B"/"NY" entries are tray **#53/#54**, not #55/#57 as the directive states — same ruling as Part 1's G-12: **the code is right, the spec is wrong.** #55 and #57 are unlabelled yellow tiles in real 1830.

4. **Tiles 4 and 5 are invented artwork.** "River crossing" and "mountain pass" have no 1830 tray equivalent — terrain is a hex property in the real game, never a tile. This is the frontend-visible half of Part 1's G-10.

5. **Real tray quantities still need sourcing.** When implementing depletion, the per-tile counts must be read off the physical 1830 tile manifest (or `tobymao/18xx`'s `g_1830/game.rb` `TILES` hash, which the catalog comments already cite for path data). I have deliberately **not** guessed them here — a wrong quantity is worse than a documented blank.

---

## 3. Prioritized Action Plan

### 🔴 F-1 — The Rail Map has no route rendering layer whatsoever

**Files:** `frontend/src/components/HexGridRenderer.tsx` (prop interface `:5600-5670`), `frontend/src/App.tsx:1890-1926`

`HexGridRenderer`'s complete prop surface is: `mapGrid`, `hexSize`, `width`, `height`, `className`, `queryClient`, `contractAddress`, `gameId`, `protocolId`, `onHexClick`, `onHexClickQuery`, `previewTile`, `currentEra`, `publicCompanies`, `panX`, `panY`, `zoom`. **There is no route, path, train, or highlight prop.**

The bezier machinery is real but serves a different purpose: `bezierTrackSegment` (`:7894`) draws **static track artwork on tiles**. Zero matches across the whole tree for `routePath`, `routeHexes`, `highlightRoute`, `trainId`, or any per-train colour table.

Consequence: `routePoints` (`App.tsx:1430`) accumulates a manual route chain and validates adjacency client-side (`:1461`), but the player's selected route is **never drawn on the map** — it appears only as a text chip list in the action bar. And since Part 1's G-9 established the backend runs one train on one route, there is no multi-train data to render even if the layer existed.

**Action:**
1. Add `routeOverlays?: Array<{ trainLabel: string; color: string; hexes: Array<[number, number]> }>` to `HexGridRendererProps`.
2. Draw it as a new pass after track splines but before station badges (respect the existing z-order documented at `:1073`), reusing `bezierTrackSegment` with a wider stroke and per-train colour.
3. Thread `routePoints` in immediately for the manual-route case — that is a self-contained win available **today**, before any backend change.
4. True multi-train rendering is blocked on Part 1's G-9. Sequence it after.

---

### 🔴 F-2 — Terrain cost badges disagree with the spec *and* with the contract

**File:** `frontend/src/components/HexGridRenderer.tsx:3744-3747`

```ts
const TERRAIN_BUILD_COST_LABEL = { River: "80", Mountain: "120" };
```

Three-way disagreement:

| Source | River | Mountain |
|---|---|---|
| Audit spec (this directive) | $20 | $80 |
| Backend `TILE_CATALOG` (tile 4 / tile 5) | $40 | $80 |
| **Frontend badge (what the player sees)** | **$80** | **$120** |

The frontend numbers are the correct real-1830 printed terrain costs — the UI is the most rules-accurate of the three. But it **displays a price the contract will not charge**: the player sees "$80" on a river hex, and `execute_lay_tile` debits $40 (or **$0** if they lay a plain tile there, since the cost rides on tile artwork rather than the hex).

This is a rules-integrity defect, not a cosmetic one: a tournament player budgets treasury against displayed build costs.

**Action:** blocked on Part 1's G-10 (move the fee from tile → hex). Once the backend exposes a per-hex `terrain_build_fee`, drive this label from a query rather than a hardcoded map. Until then, **reconcile the three numbers and pick one** — recommend the real-1830 $80/$120 that the frontend already uses, and correct the spec.

---

### 🔴 F-3 — No `$JUNO` native balance query exists

**Files:** `frontend/src/context/WalletContext.tsx`, `frontend/src/App.tsx:632-702`

Verified absent across the whole tree: no `getBalance`, no `StargateClient` bank query, no `nativeBalance`/`junoBalance` state.

What `DashboardControlBar` displays as the balance (`App.tsx:701`) is `vgpBalance` — resolved at `:1259` from `gameState.player_cash`, i.e. **Virtual Game Points**, the in-game play money. The player's real `ujuno` holdings are never queried or shown. Since the ante is a real-JUNO deposit, a player cannot see whether they can afford to join a room.

**Action:**
1. `WalletContext.tsx` — add `nativeBalance: Coin | null` plus a `refreshNativeBalance()` using the existing `SigningCosmWasmClient`'s `getBalance(address, "ujuno")`.
2. Convert `ujuno → JUNO` for display at 6 decimals (`juno_developer_spec.md` §1) using integer string math, never `Number` division — the same no-float discipline the contract holds itself to.
3. `DashboardControlBar` — render both, clearly distinguished: `$JUNO 12.500000` (real) beside `VGP 600` (game). Conflating them is the exact confusion this dashboard should prevent.

---

### 🟠 F-4 — Session-key fee granter is an unresolved placeholder

**File:** `frontend/src/utils/sessionKey.ts:72`

```ts
const DEVELOPER_FEE_GRANTER_ADDRESS = "juno1...devfeegrantaddress...";
```

Every gameplay tx routes `granter: feeGranter` (`:373`). This string is not a valid bech32 address, so **every session-key transaction will fail at fee-grant resolution** the moment this is pointed at a live chain. Part 1 confirmed the contract *does* fund a developer treasury from creation deposits (`contract.rs:673-683`) — the two halves of the gas-subsidy feature exist but are not connected.

`App.tsx` also runs on `MOCK_GAME_ID = 1` (`:517`) with a placeholder `CONTRACT_ADDRESS`.

**Action:** move all three to `.env` (`REACT_APP_FEE_GRANTER`, `REACT_APP_CONTRACT_ADDRESS`, `REACT_APP_CHAIN_ID`) and fail loudly at startup if unset, rather than shipping a string that silently produces broken transactions. Wire `DEVELOPER_FEE_GRANTER_ADDRESS` to the same address `GameConfig::developer_treasury` holds.

---

### 🟠 F-5 — `isMyTurn` is wrong for the entire Operating Round

**File:** `frontend/src/App.tsx:1289`

```ts
const isMyTurn = !!wallet.address && !!activePlayerAddress && wallet.address === activePlayerAddress;
```

`activePlayerAddress` (`:1281`) is `player_addresses[active_player_index]` — the **Stock Round** turn pointer. During an Operating Round the acting entity is the corporation at `active_operating_order[active_corporation_index]`, and the authorized human is that corporation's `president`. Part 1 confirmed the backend gates `LayTile`/`BuyHardwareFromPool`/`DeclareDividends`/`EndOperatingRoundTurn` on exactly that.

So for every Operating Round: the mandatory turn alerts (title flash + pulse glow) fire for whoever happens to hold the stale SR pointer, and the president who actually must act gets **no alert at all**. Both halves of the Module 2 notification requirement are functionally inverted for roughly half of game time.

**Action:** make `isMyTurn` round-type aware:
```ts
const isMyTurn = useMemo(() => {
  if (!wallet.address || !gameState) return false;
  if (gameState.current_round_type === "OperatingRound" && gameState.active_operating_order.length > 0) {
    const id = gameState.active_operating_order[gameState.active_corporation_index];
    return gameState.public_companies.find((c) => c.company_id === id)?.president === wallet.address;
  }
  return gameState.player_addresses[gameState.active_player_index] === wallet.address;
}, [wallet.address, gameState]);
```
Every field this needs is already on the polled `GameStateResponse`. No backend change required.

---

### 🟡 F-6 — Sell bundle selector caps at 40%

**File:** `frontend/src/components/StockRoundPanel.tsx:87`

`SELL_PERCENTAGE_OPTIONS = [10, 20, 30, 40]`. A player holding 60% cannot dump 50% in one action, and a president executing a legal dump-and-transfer has no control for it. The backend accepts any multiple of 10 up to holdings (bounded by the 50% pool cap).

**Action:** derive options dynamically from `min(playerHolding, 50 - bank_pool_percentage)` in 10% steps, and grey out sizes the pool cap would reject with a tooltip stating why — real rules feedback rather than a silent absence.

---

### 🟡 F-7 — No client-side surfacing of SR1 / pool-cap / president-sale restrictions

**Files:** `StockRoundPanel.tsx`, `RulesReference.tsx`

Zero references to `macro_round_number`, the SR1 no-sell rule, or the 50% Bank Pool cap in either panel. Sell controls render identically in SR1 (where every sale is illegal) as in SR4. `RulesReference.tsx` documents the certificate limit and the 50–200% private-purchase bound, but neither of these.

Note that SR1 enforcement is *also* missing from the backend (Part 1, G-6) — so today the illegal move is neither blocked nor warned about at any layer.

**Action:** once G-6 lands, disable the sell section when `macro_round_number === 1 && current_round_type === "StockRound"` with an inline "No sales permitted in Stock Round 1" note, and add both rules to `RulesReference.tsx`'s Core Limits & Caps section.

---

### 🟡 F-8 — Dead code: `FeedOverlay.tsx` and the `Chatbox` import

**Files:** `frontend/src/components/FeedOverlay.tsx` (510 lines), `frontend/src/App.tsx` (`Chatbox` import)

`FeedOverlay.tsx` is imported by nothing — superseded by `TopTicker`'s in-place accordion, as its own header states. `Chatbox` is imported in `App.tsx` but never rendered (`<Chatbox` appears zero times). 888 lines of misleading surface area.

**Action:** delete `FeedOverlay.tsx`; drop the unused `Chatbox` import (and the component too, if `TopTicker` + `InlineQuickChat` fully replace it).

---

## 4. What is genuinely solid

- **`utils/gameState.ts`** is exemplary infrastructure: three independent polling hooks, each with a monotonic request-sequence guard against stale responses, and a `playersKey` join-string dependency that correctly avoids rebuilding intervals on every same-content JSON re-parse. That last detail is a bug most codebases ship.
- **The auto-tab switcher** uses a `useRef` to fire only on genuine `current_round_type` transitions, so it never fights a manual tab click on an unchanged poll tick. Exactly right.
- **`TileSelectionPopup` refuses to re-implement tile legality client-side** and renders only what `GetLegalTilePlacements` returns. This is why there is no drift between the two layers' tile rules — and it is the reason the Tile Manifest has a single source of truth to report.
- **Ticker module layout** matches the spec precisely: docked below the tabs, colour-matched to eliminate dark gaps, 7-line in-place accordion, no modal, chat input with filter pills flush right.
- **The codebase documents its own known gaps honestly** in design notes rather than hiding them — several findings here were self-flagged first. That is rare and worth preserving.

---

## 5. Recommended remediation order

| Priority | Item | Blocked on |
|---|---|---|
| 1 | **F-5** — `isMyTurn` OR-awareness | Nothing — pure frontend, high impact |
| 2 | **F-3** — `$JUNO` native balance | Nothing |
| 3 | **F-4** — fee granter / env config | Nothing — but blocks any live deployment |
| 4 | **F-1** step 3 — draw `routePoints` on canvas | Nothing |
| 5 | **F-6, F-8** — sell options, dead code | Nothing |
| 6 | **F-7** — SR1/pool-cap UI | Part 1 G-6 |
| 7 | **F-2** — terrain cost reconciliation | Part 1 G-10 |
| 8 | **F-1** full — multi-train overlay | Part 1 G-9 |
| 9 | **Tile manifest** — quantities + tray numbers | Part 1 G-5 |

Items 1–5 are all unblocked frontend work available immediately.

---

*End of Part 2. Parts 1 and 2 together cover the full `src/` and `frontend/src/` trees.*
