# 18Cosmos System Audit — Part 1: Rust CosmWasm Backend (`src/`)

**Scope:** all 15 non-test Rust modules under `src/` (14,204 LOC excl. `tests.rs`).
**Mode:** READ-ONLY. No files modified.
**Auditor posture:** Principal Systems Engineer + 1830 Tournament Rules Judge.
**Note:** `cargo` is unavailable in this sandbox, so findings are from static analysis of source, not compiler/test output.

---

## 1. Status Matrix

| # | Backend Engine Module | Status | Severity of worst gap |
|---|---|---|---|
| 1 | Juno Room Escrow & Ante Mechanics | **Partially Implemented / Gap** | 🔴 Critical |
| 2 | Pre-Game Waterfall Auction Engine | **Fully Implemented** | — |
| 3 | Stock Round (SR) Engine | **Partially Implemented / Gap** | 🔴 Critical |
| 4 | Operating Round Flow & Phase Shifts | **Partially Implemented / Gap** | 🔴 Critical |
| 5a | Restricted Tile Upgrade Validation ("B"/"NY"/"OO") | **Fully Implemented** | 🟡 Naming only |
| 5b | Map Pathfinder (continuity, splines, blockades, fees) | **Partially Implemented / Gap** | 🟠 High |
| 6 | On-Chain Tile Inventory Depletion | **NOT IMPLEMENTED** | 🔴 Critical |
| 7 | Emergency Purchases & Insolvency Engine | **Partially Implemented / Gap** | 🟠 High |
| 8 | Game-End & Deferred Settlement | **Partially Implemented / Gap** | 🔴 Critical |

### Sub-item detail

| Checklist item | Status |
|---|---|
| **1.** Ante deposit state | ✅ `PLAYER_JUNO_ANTE` + Uniform Ante Rule enforced to the `ujuno` |
| **1.** Protocol take fee | ⚠️ Creation only — **entry/join deposits are untaxed** |
| **1.** Net-worth proportional distribution | ❌ Present but **valuation math is 10× wrong** (see G-1) |
| **1.** 48-hour inactivity timeout | ✅ `INACTIVITY_TIMEOUT_SECONDS = 172_800`, refund path complete |
| **2.** $20–$220 privates, $5 raises, escrow, auto-award, tie mini-auction, B&O binding | ✅ All six present and correct |
| **3.** Single buy / multi-sell | ✅ |
| **3.** SR1 sale restriction | ❌ **Entirely absent** |
| **3.** Par value $67–$100 | ✅ `PAR_VALUE_LADDER` 67/71/76/82/90/100 |
| **3.** 60% float threshold | ✅ `FLOAT_THRESHOLD_PERCENTAGE` + 10× par capitalization |
| **3.** Dynamic President transfer (20%) | ⚠️ Seat re-derived, but **dumping is blanket-blocked, not executed** |
| **3.** Zone rules (White/Yellow/Orange/Brown) | ✅ `ZoneType` nested semantics + Brown multiple-buy |
| **3.** 50% Bank Pool limit | ✅ Pre-checked before any write |
| **3.** 1 cell down per 10% sold | ⚠️ Correct count, **wrong price applied** (see G-4) |
| **4.** Operating order sort | ✅ Price desc, `arrival_sequence` tiebreak |
| **4.** Dividend full/withhold | ✅ Both paths + market movement |
| **4.** Treasury vault routing | ❌ **Two divergent treasuries; withheld cash is unspendable** (G-2) |
| **4.** Phase progression | ✅ `ERA_UNLOCK_TRIGGERS`, `OR_SEQUENCE_LENGTH_BY_TIER` |
| **4.** Train rusting (2s/3s/4s) | ✅ `RUST_TRIGGERS` 4→2, 6→3, D→4 |
| **4.** Phase-5 private auto-closure | ✅ + B&O special closure |
| **5.** "B" Boston & Baltimore Yellow→Green→Brown | ✅ Enforced in both `execute_lay_tile` and `legal_tile_placements` |
| **5.** "NY" Yellow→Green→Brown | ✅ Enforced in both |
| **5.** "OO" ×4 Yellow→Green→Brown (5 variants) | ✅ Enforced in both |
| **5.** Track continuity | ⚠️ Edge-level only, **no intra-tile path pairing** (G-6) |
| **5.** Multi-train spline isolation | ❌ **Absent** — single best route only |
| **5.** Competitor token blockades | ⚠️ Uses *home hexes*, not `PROTOCOL_STATION_HEXES` |
| **5.** Terrain fees $20 river / $80 mountain | ❌ **Modeled on the tile, not the hex** (G-7) |
| **6.** `remaining_tiles` inventory state | ❌ **Does not exist** |
| **6.** Depletion enforcement | ❌ **Does not exist** |
| **7.** Mandatory train purchase | ❌ **Not enforced** — a trainless corp may end its turn freely |
| **7.** Cascade Treasury → Personal → Liquidation | ⚠️ **Liquidation tier missing** — jumps straight to bankruptcy |
| **7.** Hard-halt bankruptcy | ✅ Correctly implemented as `Ok(Response)`, not `Err` |
| **8.** Deferred bank-break | ✅ `bank_is_broken` consumed at OR-block boundary |
| **8.** Net worth appraisal | ❌ 10× bug + excludes privates (G-1, G-3) |

---

## 2. Gap Details & Action Plan

### 🔴 G-1 — Net Worth undervalues all stock by exactly 10× (real-JUNO payout bug)

**File:** `src/contract.rs`, `calculate_player_net_worth`, lines **943–947**

```rust
let company_share_value = cell.price
    .checked_mul(Uint128::from(percentage))?   // percentage is 0-100
    .checked_div(Uint128::new(100))?;          // ← treats price as WHOLE-COMPANY value
```

`MARKET_GRID.price` is the **per-certificate (10%) price** — proven by `PAR_VALUE_LADDER` ($67…$100 are 1830 per-share pars) and by `FLOAT_CAPITALIZATION_MULTIPLIER = 10` (`treasury = par × 10` = whole company). A 20% holding at $67 is therefore worth **$134**, but this returns **$13**.

`src/query.rs:453-457` (`query_player_net_worth`) does it **correctly** — `certificate_count = pct / 10; value = price × certificate_count`. **The two functions disagree by 10×**, and the wrong one is the one that signs `BankMsg::Send`.

This does *not* wash out in the proportional split: `PLAYER_CASH_VGP` is added at full weight, so a stock-heavy player is systematically robbed in favour of a cash-heavy player, in **real JUNO**.

**Action:** rewrite `calculate_player_net_worth` to mirror `query::query_player_net_worth` exactly (divide `percentage` by `trading::PERCENT_PER_SHARE`, multiply by price). Better: extract one shared `pub(crate) fn appraise_player_net_worth` and have both call sites use it, so they can never drift again.

---

### 🔴 G-2 — Split treasury: withheld dividends land in an account nothing can spend

**Credit sites:** `src/trading.rs:1472-1478` and `:1502-1508` → `PROTOCOL_TREASURY_VGP`
**Debit sites:** `src/hardware.rs:625` (train buy), `src/hexmap.rs:3104` (terrain cost), `src/hexmap.rs:3396` (station token) → `PublicCompany::treasury`
**Third writer:** `src/operations.rs` withhold path → `PublicCompany::treasury`

`DeclareDividends { distribute: false }` — the primary 1830 "Slash/Retain Yield" action — credits `PROTOCOL_TREASURY_VGP`. **Nothing in the codebase ever debits that map.** A corporation that withholds for five ORs to save for a 5-train has, on-chain, saved nothing spendable. It is already flagged as "Treasury divergence (flagged, not fixed here)" in `operations.rs` module doc #4 — this audit rates it **Critical**, not a note: it silently breaks the entire capital-accumulation loop of the game.

**Action:** delete `PROTOCOL_TREASURY_VGP` from `src/state.rs:527` and migrate both `trading.rs` withhold branches to read/write `PublicCompany::treasury` via `PUBLIC_COMPANIES`. Single source of truth.

---

### 🔴 G-3 — Net Worth omits private companies and corporate treasuries

**File:** `src/contract.rs:916-971` and `src/query.rs:409-472`

Tournament 1830 final net worth = cash + share value + **face value of every private company still held**. Neither appraiser reads `PRIVATE_COMPANIES`. A player who bought B&O at $220 and holds it to game end books $0 for it.

**Action:** add a `PRIVATE_COMPANIES` loop to the shared appraiser from G-1, summing `cost` for every private where `owner == Some(player)` and `!closed`. Confirm the design decision to exclude corporate treasury (currently documented as deliberate) still matches your tournament ruleset.

---

### 🔴 G-4 — Multi-certificate sales walk the price down *during* the sale

**File:** `src/trading.rs:1218-1252` (the `for _ in 0..num_certificates` loop)

Each iteration reads `current_cell()`, credits that price, then calls `move_down`. Selling 30% therefore settles cert #2 one row lower than cert #1, and cert #3 two rows lower.

**1830 ruling:** all certificates in a single sale transact at the price at the *start* of the sale; the marker then moves down one space **per certificate sold**, after the money changes hands. Every reference implementation (`tobymao/18xx`, 18xx.games) does it this way. The inline comment claiming this "matches the physical 18xx board" is incorrect.

**Action:** hoist `let sale_price = market::current_cell(...)` above the loop; credit `sale_price × num_certificates` in one shot; then loop `num_certificates` times calling only `market::move_down`.

---

### 🔴 G-5 — Module 6 (Tile Inventory Depletion) does not exist at all

**Files:** `src/state.rs`, `src/hexmap.rs`

Verified absent: no `remaining_tiles`, no `TILE_SUPPLY`, no quantity field on `TILE_CATALOG` (`src/hexmap.rs:972`, tuple is `(tile_id, connections, cost, terrain, color)` — no count), and neither `execute_lay_tile` (`:2675`) nor `legal_tile_placements` (`:2432`) reads or writes any inventory. The physical 1830 tile tray — a genuine, frequently decisive strategic constraint — is currently infinite.

**Action plan:**
1. `src/hexmap.rs:972` — extend `TILE_CATALOG` to `(u32, u8, u128, TerrainType, TileColor, u32 /* qty */)` with real 1830 tray counts; update the 3 destructuring sites (`:2505`, `:2738`, and `tile_base_value`/`tile_color_for`/`tile_terrain_for` at `:1916-1951`).
2. `src/state.rs` — add `pub const REMAINING_TILES: Map<(u64, u32), u32> = Map::new("remaining_tiles");`
3. `src/contract.rs:execute_create_game_room` (~line 765, beside `spawn_hardware_pool`) — add `hexmap::seed_tile_inventory(deps.storage, game_id)?`.
4. `src/hexmap.rs:legal_tile_placements` — add `if remaining == 0 { continue; }` inside the `TILE_CATALOG` loop, next to the Tech-Era colour gate.
5. `src/hexmap.rs:execute_lay_tile` — new `HexMapError::TileExhausted { tile_id, hex_label }`; decrement on success **and return the replaced tile to the tray** on a colour upgrade (1830 recycles the old tile).
6. `src/gamelog.rs:reapply_game_log` — reset and replay inventory alongside the other replayable state, or Undo will corrupt the tray.

---

### 🔴 G-6 — Stock Round 1 sale restriction absent

**File:** `src/trading.rs:1125` (`execute_sell_stock`)

Zero references to `macro_round_number` anywhere in `trading.rs`. In 1830 **no share may be sold during SR1** — a foundational opening-game constraint. Players can currently pump-and-dump on turn one.

**Action:** at the top of `execute_sell_stock`, after the `waterfall_auction_active` check, add:
```rust
if session.macro_round_number == 1 && session.current_round_type == RoundType::StockRound {
    return Err(TradingError::SalesProhibitedInFirstStockRound { game_id });
}
```
Related: `current_round_type` is currently **not** an enforcement gate at all (`operations.rs` module doc #12 flags this) — `BuyStock`/`SellStock` are legal during an Operating Round. Gate both on `RoundType::StockRound` in the same pass.

---

### 🟠 G-7 — President's certificate cannot be dumped; a legal move is illegally blocked

**File:** `src/trading.rs:1190-1213`

The current rule rejects **any** sale by a sitting President unless another player already holds ≥20%. That is stricter than 1830 and blocks legal play: a President holding 60% may legally sell 10% (to 50%) even with no 20% successor, because they remain the largest holder and keep the seat. `recalculate_president` (`:517`) then re-derives the seat correctly — the pre-check fires before it ever gets the chance.

Conversely, the actual 1830 **stock dump** (President sells below the second-largest holder; the 20% certificate transfers and the outgoing president receives 2×10% back) is never executed — only refused.

**Action:** replace the blanket pre-check with a simulation: compute `seller_pct - percentage`, find the max holding among other players, and reject only if the seller would fall below `PRESIDENT_MIN_PERCENTAGE` **and** no other player reaches it. On a legal dump, let `recalculate_president` transfer the seat (percentage bookkeeping already nets out correctly, since `PLAYER_SHARES` stores percentages rather than discrete cards).

---

### 🟠 G-8 — Mandatory train purchase not enforced; liquidation tier missing

**Files:** `src/operations.rs:773` (`execute_end_operating_round_turn`), `src/hardware.rs:675` (`execute_emergency_buy_hardware`)

Two distinct gaps:

1. **No mandatory purchase.** `execute_end_operating_round_turn` performs no `COMPANY_HARDWARE` emptiness check. A corporation with zero trains ends its turn with no consequence. `hardware.rs` module doc #6 concedes this: *"nothing calls this automatically yet."*
2. **Cascade stops one tier early.** The implemented order is Corp Treasury → President's `PLAYER_CASH_VGP` → **bankruptcy**. The specified **Emergency Asset Liquidation** tier (forced sale of the President's personal share portfolio into the Bank Pool to raise the shortfall) is absent — so games will declare bankruptcy on presidents who are, in 1830 terms, solvent.

**Action:**
- `operations.rs:execute_end_operating_round_turn` — before advancing, if `COMPANY_HARDWARE` is empty and `HARDWARE_POOL` is non-empty, return `OperationsError::MustPurchaseTrain { protocol_id }`.
- `hardware.rs` — insert `fn liquidate_president_assets(...)` between the personal-cash check (`:727`) and the bankruptcy branch (`:733`): iterate the President's `PLAYER_SHARES`, force-sell into `BANK_POOL_SHARES` (respecting the 50% cap and applying `market::move_down` per certificate) until the deficit is covered. Only if liquidation still falls short does the existing `finalize_and_distribute_payouts` bankruptcy path fire.

---

### 🟠 G-9 — Pathfinder is hex-level, not path-level; no multi-train isolation

**File:** `src/pathfinding.rs` (module doc #3, #4, #5), `src/hexmap.rs:972` (`TILE_CATALOG` `connections` field)

`state::Tile.connections` is a 6-bit "which edges carry track" mask. It records **that** edges have track, never **which edges pair to which**. `hexmap.rs`'s own comment on tile 21 concedes: *"doesn't distinguish per-city edge pairing for backend legality."* Consequences:

- A route may enter a tile on edge 0 and exit on edge 3 even when the printed artwork routes 0→2 and 3→4. **Illegal routes score revenue.**
- `trace_best_route` (`:300`) returns the single best route for the single best train (module doc #4). **Multi-train operation is unimplemented**, and therefore so is spline isolation — the rule that two trains may not reuse the same track segment in one OR has nothing to isolate.
- Minimum 2-revenue-centre rule not enforced (module doc #5) — a lone home hex scores.
- `opponent_station_hexes` (`:275`) blocks on each rival's *first laid tile*, not on `PROTOCOL_STATION_HEXES`. The real token registry exists and is populated by `execute_place_station_token` (`hexmap.rs:3255`) but the pathfinder ignores it, and open-slot pass-through is not modeled.

**Action (largest item in Part 1, likely its own milestone):**
1. `src/state.rs` — replace/augment `Tile.connections: u8` with `paths: Vec<(u8, u8)>` (edge-pair list) or a packed `u16` adjacency; source real path data from the `tobymao/18xx` citations already sitting in `TILE_CATALOG`'s comments.
2. `src/pathfinding.rs` — traverse edge-pairs, not hexes; add `trace_best_route_set(company)` returning one route per owned train with a shared `HashSet<(hex, edge_pair)>` claimed-segment ledger.
3. Repoint `opponent_station_hexes` at `PROTOCOL_STATION_HEXES` and implement slot-count blocking.
4. Enforce `visited_revenue_centres >= 2`.

---

### 🟡 G-10 — Terrain fee is a property of the tile, not the hex

**File:** `src/hexmap.rs:972` (`TILE_CATALOG` cost field), `:3096-3120` (charge site)

Costs are attached to **tile artwork**: tile 4 "river crossing" = $40, tile 5 "mountain pass" = $80. In 1830 the build fee belongs to the **hex**, not the tile. Practical exploits today:
- Laying a plain straight (tile 1, cost $0) onto a genuine river/mountain hex is **free**.
- Laying the "mountain pass" tile onto flat grassland costs **$80** for nothing.
- The spec'd **$20 river** doesn't appear anywhere; the catalog says $40.

**Action:** add `RIVER_HEXES` / `MOUNTAIN_HEXES` coordinate tables to `hexmap.rs` beside `IMPASSABLE_HEX_EDGES` (`:1980`), add `fn terrain_build_fee(q, r) -> Uint128` returning $20/$80/$0, and charge that at `:3096` instead of `TILE_CATALOG`'s embedded cost. Zero the catalog cost field or repurpose it.

---

### 🟡 G-11 — Protocol take fee is not applied on room entry

**File:** `src/contract.rs:835` (`execute_join_game_room`)

`execute_create_game_room` (`:673-683`) correctly deducts `subsidy_fee_percentage / BPS_DENOMINATOR` and routes it to `config.developer_treasury`. `execute_join_game_room` adds `joined_amount` to `total_juno_pool` **untaxed** (`:1046`), with the docstring stating this is intentional. The audit checklist specifies "room creation **/ entry**".

**Action:** if entry should be taxed, apply the identical subsidy calculation in `execute_join_game_room` and append the treasury `BankMsg::Send`. **Caution:** the Uniform Ante Rule compares `joined_amount` against the creator's **gross** `PLAYER_JUNO_ANTE` entry — decide whether that ledger stores gross or net *before* changing this, or joins will start failing `InvalidAnteAmount`.

---

### 🟡 G-12 — Tile IDs are internal, not 1830 tray numbers (and the spec's numbers are wrong)

**File:** `src/hexmap.rs:972-1200`

On-chain `tile_id`s are a renumbered internal sequence. The mapping to real 1830 tray numbers lives only in comments:

| Restriction | Audit spec says | On-chain `tile_id` | Real 1830 tray # (per code's `tobymao/18xx` verification) |
|---|---|---|---|
| "B" Green | #55 | **16** | **#53** ← spec is wrong |
| "NY" Green | #57 | **17** | **#54** ← spec is wrong |
| "OO" Green | #59 | **15** | #59 ✓ |
| "B" Brown | #61 | **18** | #61 ✓ |
| "NY" Brown | #62 | **19** | #62 ✓ |
| "OO" Brown | #64–#68 | **20, 21, 22, 23, 24** | #64–#68 ✓ |

**Judge's ruling: the codebase is right and the audit checklist is wrong on the two Green entries.** In real 1830, #55 is an unlabelled yellow double-town tile and #57 is an unlabelled yellow city tile — neither carries a "B" or "NY" label. The correct Green upgrades are #53 (label B) and #54 (label NY). `hexmap.rs` module doc #28 documents catching and correcting exactly this error in an earlier pass. **Please correct the master specification.**

Separately, the **Yellow setup** step for B/NY hexes is not materialised in `MAP_GRID` — those hexes are preprinted yellow on the physical board, but on-chain they read as empty until the Green tile is laid as a *fresh placement* (which also means the president pays a terrain fee for it). Functionally acceptable; flagged so the frontend renders the preprinted state rather than bare land.

**Action:** either renumber `TILE_CATALOG` to real tray numbers (breaking change — `ActionRecord::LayTile` in `GAME_LOG` stores `tile_id`, so existing rooms' Undo history would corrupt), or add `pub fn real_tray_number(tile_id: u32) -> Option<u32>` and surface it through `msg::LegalTilePlacement` + `MapTileEntry` so the frontend and rules documentation can speak tray numbers.

---

### 🟡 G-13 — Double private-revenue payout across the two OR mechanics

**File:** `src/operations.rs` module doc #14, `execute_operating_round:348` vs `pay_private_company_revenues:622`

Two independent OR systems coexist: the legacy creator-batched `ExecuteOperatingRound`, and the sequential `BeginOperatingRound`/`EndOperatingRoundTurn` queue. Both pay private revenue. A room driving both within one OR pays every private **twice**. Already self-flagged in the module doc; confirmed live.

**Action:** pick one mechanic. Recommend deprecating `ExecuteOperatingRound` (remove the variant from `msg.rs:158`) now that the sequential queue plus `RunManualRoute` covers its ground.

---

## 3. What is genuinely solid

Credit where due — these held up to adversarial reading:

- **Waterfall Auction** (`waterfall.rs`, 938 lines) is the strongest module in the tree. Cascade resolution, seating-order mini-auctions, leader-turn skipping, the all-pass early-termination edge case *and* its bid-refund sweep, and the `last_private_winner`-relative Priority Deal assignment are all correct and correctly handle the "everyone bid, nobody bought" degenerate case.
- **B/NY/OO restricted-upgrade enforcement** is airtight and — critically — **mirrored identically** in both `execute_lay_tile` and `legal_tile_placements`, with a maintenance note binding them. The four-branch disjoint match (OO → B → NY → generic fallback) correctly rejects substitute artwork in *both* directions (wrong tile on right hex, right tile on wrong hex).
- **Bankruptcy-as-`Ok(Response)`** (`hardware.rs` module doc #7) shows real CosmWasm fluency — returning `Err` would have reverted the `is_active = false` write and made the halt unenforceable on-chain.
- **Checks-Effects-Interactions** discipline is consistently applied; every `BankMsg` dispatch follows its state writes.
- **Determinism:** zero `f32`/`f64` anywhere. All money math is `checked_*` `Uint128`.
- **Certificate counting** correctly treats the President's 20% card as **one** certificate, not two — a subtle rule most implementations get wrong.

---

## 4. Recommended remediation order

1. **G-1** (10× payout bug) — real funds, one-line fix class, highest damage-to-effort ratio.
2. **G-2** (split treasury) — silently breaks the corporate economy.
3. **G-6 / G-4** (SR1 restriction, sale pricing) — Stock Round legality.
4. **G-5** (tile inventory) — self-contained new subsystem, no dependency on the others.
5. **G-8** (mandatory purchase + liquidation) — insolvency correctness.
6. **G-3, G-7, G-11, G-12, G-13** — correctness and hygiene.
7. **G-9 / G-10** (path-level routing, hex terrain fees) — the largest structural change; schedule as its own milestone.

---

*End of Part 1. Part 2 (frontend `frontend/src/`) pending.*
