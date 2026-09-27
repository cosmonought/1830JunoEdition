# 18Cosmos Core Engine Rules (Based on 1830 Baseline)

## 1. Core Economic Framework & Tokenomics
- The system operates strictly via fixed-point integer math. No floating-point operations.
- The base network asset acts as the game currency ($JUNO / "Gas"). All financial tokens scale to 6 decimal places (`Uint128`).
- The Game Engine orchestrates a continuous sequence of alternating phases: one Stock Round (SR) followed by a set number of Operating Rounds (OR).

## 2. Stock Round (SR) Architecture
- **Order of Play**: Driven by a priority card queue that shifts dynamically as players buy, sell, or pass.
- **Corporate Entities (Protocols)**:
  - Public Protocols are launched via an initial offering mechanism.
  - A Protocol floats (activates) immediately when exactly 60% of its total token/share supply is purchased by players.
  - The player holding the highest percentage of shares (minimum 20%) is designated the "Validator" (President) and controls all operational actions.
- **Transaction Rules**:
  - During their turn, a player may sell any amount of tokens back to the Open Market Pool, then purchase exactly 1 token/share from an Initial Offering or the Open Market Pool.
  - Alternatively, a player can choose to Pass. A Stock Round terminates instantly when all players pass consecutively.

## 3. Operating Round (OR) Architecture
- **Execution Order**: Protocols execute sequentially, sorted from highest token price to lowest token price on the market matrix.
- **Step 1: Network Infrastructure & Tile Placement**:
  - The Validator pays Gas from the Protocol Treasury to place or upgrade a hex tile on the shared map network.
  - Connection edges (0-5) dictate valid physical path routing.
- **Step 2: Token Station Placement**:
  - Protocols can pay a fixed fee to establish a "Node" (Station) on specific hex cities to secure routing rights and block competing protocols.
- **Step 3: Revenue Generation & Yield Routing**:
  - The Validator traces valid grid paths using the Protocol's active "Hardware" (Trains) to calculate total network yield.
  - Path tracing must obey connection paths and cannot bypass blocking enemy Nodes.
- **Step 4: Dividend Distribution (Yield Allocation)**:
  - **Distribute Yield**: Total earnings are split proportionally among all token holders. The Protocol's market price advances upward on the market matrix.
  - **Slash/Retain Yield**: 100% of earnings are held back inside the Protocol Treasury. The Protocol's market price drops downward on the market matrix.

## 4. Hardware Asset Upgrades (Train Cycles)
- Hardware assets are purchased sequentially from a fixed global supply pool (e.g., Type-2, Type-3, Type-4, Type-5, Type-6, Type-D).
- **Obsolescence (Rusting)**: The instant the first Type-4 asset is purchased from the global pool, all older Type-2 hardware assets are permanently deprecated (deleted from state). The purchase of a Type-6 asset permanently deprecates all Type-3 assets.
- **Validator Liability**: If a Protocol owns 0 active hardware assets during its OR step, the Validator address is legally forced to inject personal funds to purchase a new piece of hardware at baseline market cost. Failure to afford this triggers a liquidation event.
