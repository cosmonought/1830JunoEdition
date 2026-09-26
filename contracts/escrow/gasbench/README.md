# escrow-gasbench

Runs the **optimized** escrow wasm inside a real CosmWasm VM and prints the gas
of every settlement path, including worst-bound shapes up to the 64-key /
64-checkpoint cap. It is the gas half of the predeployment gate
(`ESCROW2_PREDEPLOYMENT_WASM_GAS_GATE_2026-09-26`).

It is a stand-alone crate: it has its own `[workspace]` and `Cargo.lock`, so the
contract's lockfile and the optimizer's workspace build never see the VM's
dependency tree.

## What it measures

- **VM:** `cosmwasm-vm =3.0.5`, the VM Juno v30.0.0 bundles through wasmvm
  v3.0.4. It runs singlepass with metering, as a node does.
- **Static validation:** the artifact is stored with the check on, so this VM
  version's static validation must accept it before anything runs.
- **Measured:** `used_internally` per call, which is wasm execution plus host
  calls such as `secp256k1_verify`, in CosmWasm gas.
- **Modelled from the exact storage operations the contract performed** (wasmd
  v0.54/v0.61 defaults and the Cosmos SDK KV gas config):
  - VM gas ÷ 140 000;
  - 60 000 instance cost for unpinned code;
  - KV: read 1000 + 3/B, write 2000 + 30/B, delete 1000, iterator 30 per step
    + 3/B. Key bytes include wasmd's 33-byte contract-store prefix;
  - events: 10 per attribute plus 1/B beyond a 100-byte free tier, and 20 per
    custom event.
- **Estimated only:** ≈12 600 SDK gas per `BankMsg::Send`. The ante handler,
  tx size and signatures of the enclosing transaction are not included.

Real chain numbers come only from simulating on the target chain. These figures
are for comparing paths, tracking growth, and finding worst cases.

## Run

```sh
# 1. The deployable artifact comes from the official optimizer (repo root).
#    0.16.1 = Rust 1.81 + `wasm-opt -Os --signext-lowering`. It runs on
#    CosmWasm 1.x/2.x/3.x chains; 0.17.x output needs CosmWasm 3.0+ chains.
docker run --rm -v "$(pwd)":/code \
  --mount type=volume,source="$(basename "$(pwd)")_cache",target=/target \
  --mount type=volume,source=registry_cache,target=/usr/local/cargo/registry \
  cosmwasm/optimizer:0.16.1

# 2. Static checks against every VM line the chain may run. 2.2.9 and 3.0.9
#    enforce at most 100 locals per function; 1.5.x and 3.0.5 do not.
cosmwasm-check artifacts/eighteen_cosmos_escrow.wasm   # repeat with cosmwasm-check 1.5.11, 2.2.9, 3.0.5 and 3.0.9 installed

# 3. Gas table (Markdown on stdout; every row as JSON in the second argument).
cd contracts/escrow/gasbench
cargo run --release -- ../../../artifacts/eighteen_cosmos_escrow.wasm gas-rows.json > gas-table.md
```

### Linking on recent Rust toolchains (Linux x86_64)

wasmer-vm 4.x/5.x imports the unmangled symbol `__rust_probestack`. Recent Rust
toolchains export compiler-builtins' stack probe only under a mangled name, so
the final link fails with `undefined symbol: __rust_probestack`. Point the
build at the toolchain's own probe, and nothing else about the VM changes:

```sh
export GASBENCH_PROBESTACK_SYMBOL=$(nm -g --defined-only \
  "$(rustc --print sysroot)"/lib/rustlib/x86_64-unknown-linux-gnu/lib/libcompiler_builtins-*.rlib \
  | awk '/___rust_probestack$/{print $3; exit}')
```

`cosmwasm-check` from crates.io fails to link for the same reason. Build it with
`cargo rustc --release --locked --bin cosmwasm-check -- -C link-arg=-Wl,--defsym=__rust_probestack=$GASBENCH_PROBESTACK_SYMBOL`.
Run that from the extracted crate source; the checker's own code is unchanged.
