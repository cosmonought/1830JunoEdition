# Juno Network Developer Specification
Technical parameters and best-practices for deploying smart contracts on Juno Network.

## 1. Network Constants & Environment
- **Daemon Binary**: `junod`
- **Native Micro-Denomination**: `ujuno` (1 JUNO = 1,000,000 ujuno). All on-chain financial operations must be integers calculated in `ujuno`.
- **Gas Fee Token**: `ujuno` must be held in the calling address to execute transactions.

## 2. Compilation and Optimization
Contracts deployed to Juno must be compiled using the official CosmWasm rust-optimizer to minimize binary size and ensure completely deterministic builds.
```bash
docker run --rm -v "$(pwd)":/code \
  --mount type=volume,source="$(basename "$(pwd)")_cache",target=/code/target \
  --mount type=volume,source=registry_cache,target=/usr/local/cargo/registry \
  cosmwasm/rust-optimizer:0.15.0
```
This produces a gas-optimized `<contract_name>.wasm` file ready for network interaction.

## 3. Deployment Pipeline via junod CLI
To safely upload and launch code blocks on Juno:

### Step A: Store Code
```bash
junod tx wasm store artifacts/juno_18xx_game.wasm \
  --from wallet-key \
  --chain-id juno-1 \
  --gas-prices 0.075ujuno \
  --gas auto \
  --gas-adjustment 1.3 \
  -y --output json
```

### Step B: Instantiate Contract
```bash
junod tx wasm instantiate <CODE_ID> \
  '{"game_id":"1830-test","admin":"juno1...","native_denom":"ujuno"}' \
  --label "18xx Contract instance" \
  --from wallet-key \
  --chain-id juno-1 \
  --no-admin \
  -y
```

## 4. On-Chain Development Safeguards
- **Float Disallowance**: Never import or invoke floating-point arithmetic (`f32` or `f64`). Any non-deterministic instruction will cause nodes to desynchronize, rejecting block verification. Use scaled mathematical calculations natively supported by `Uint128`.
- **Reentrancy Protection**: State adjustments must happen entirely *before* issuing external cosmos messages (such as transferring tokens to players via `BankMsg`). CosmWasm natively mitigates common EVM reentrancy patterns via its execution design, but order of operations remains paramount.