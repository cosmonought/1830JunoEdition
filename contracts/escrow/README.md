# eighteen-cosmos-escrow (ESCROW-2, corrected by ESCROW-2.1 and ESCROW-2.2; storage reshaped by ESCROW-2.3)

A CosmWasm 1.5 settlement escrow for Juno money rooms. It is a vault, a deposit
holder, a roster record, a secp256k1 signature verifier, a settlement/challenge
state machine and a proportional payout calculator. It is **not** a rules
engine, board store, appraiser or replay engine: the TypeScript server is the
only gameplay authority and signs `SettlementPayloadV1` payloads with a
registered settlement key. This crate shares no code with the legacy gameplay
contract at the repository root and cannot be migrated from it.

Design sources: `ESCROW_LIVE_RECONCILIATION_2026-09-25` (as amended, A1–A3),
`SET0A_NET_WORTH_VALUATION_AUDIT_2026-09-25` rev 2 §21, and the ESCROW-2.1 owner
decisions OD-ESC2-1…5 (all closed; see below).

## Build and test

```sh
cargo fmt   -p eighteen-cosmos-escrow -- --check
cargo test  -p eighteen-cosmos-escrow
cargo clippy -p eighteen-cosmos-escrow --all-targets -- -D warnings
(cd contracts/escrow && cargo run --bin schema)   # regenerates schema/
```

The crate is a workspace member of the root manifest; a bare `cargo test` at the
root still runs only the legacy crate. Release wasm builds should use the
CosmWasm optimizer; `overflow-checks = true` is set for this package's release
profile, and the library denies `clippy::arithmetic_side_effects` outside tests.

## Layout

| File | Role |
|---|---|
| `src/payload.rs` | the fixed-width `136 + 16·n` byte payload, strict decode, shape rules (kind/reason, `seq = 2·log_len + kind`, A1 appraisal rule) |
| `src/crypto.rs` | `18JUNO/{DOMAIN,ROSTER,SETTLE,CONSENT,ANNUL}/v1` digests, low-s check, compressed keys |
| `src/payout.rs` | `floor(pool·wᵢ/Σw)` in `Uint256`, checked downcast, dust; subsidy and bond arithmetic |
| `src/helpers.rs` | guards (state → role → pause → rest), payload-vs-game checks, the trusted sequence floor, consent-key uniqueness and verification, `pay_out`, `refund_all` |
| `src/execute/*.rs` | funding (create/join/withdraw/cancel/consent key), play (start/checkpoint/settle/consent/finalize), dispute (challenge/resolve/annul/liveness), admin |
| `src/storage.rs` | the storage-only `StoredGame` shape under `games`: private map, lossless `Game` conversions, and the only read/write/range paths (ESCROW-2.3) |
| `src/query.rs` | config, games (with `trusted_seq` and every open deadline), seats, checkpoints (with the liveness candidate), signer keys, settlement preview |
| `schema/` | generated JSON schema of every message and response (the ESCROW-3 client ABI) |
| `testdata/` | independent Python vector generator, its output (`payload_vectors_v1.json`), and the SET-0A rev 2 payout goldens |
| `scripts/` | `wasm-gate.sh` (optimizer build, ≤ 90 locals per function, every `cosmwasm-check`) and `wasm_locals.py` (the per-function local count) |
| `gasbench/` | stand-alone gas harness that runs the optimized wasm in cosmwasm-vm 3.0.5 (own workspace and lockfile; see its README) |

## Tests

| Suite | Covers |
|---|---|
| `vectors` | byte layout, digests and RFC 6979 signatures reproduced from the Python generator, replayed on chain |
| `golden` | SET-0A P1–P13, Q16 and the 13 case previews, off chain and on chain |
| `set0c_vectors` | SET-0C: the TypeScript builder's vectors (`frontend/src/utils/__fixtures__/settlement/settlementPayloadVectorsV1.json`) re-derived by the crate — domains, roster hashes, payload bytes, SETTLE/CONSENT digests, shape per message, payouts and dust, JSON form — plus the 71 TypeScript mutation outcomes and single-byte decoder classification |
| `funding`, `start`, `consent_key`, `checkpoint`, `settlement`, `challenge`, `resolver`, `liveness`, `annul`, `admin`, `terminal` | each message's rules, refusals and boundaries |
| `matrix` | every execute message × every state × paused/unpaused × six caller roles, against an oracle written from §9.1 as amended by the closed decisions |
| `invariants` | the seventeen escrow invariants: targeted tests plus a seeded random-sequence checker with an independent payout/refund model, which also runs the emergency rotation and finally drains every live game under a permanent pause |
| `closed_decisions` | regressions for OD-ESC2-1…5 and consent-key uniqueness (see below) |
| `compromised_settlement` | ESCROW-2.2: a stored settlement under a compromised signer key is never paid by Finalize or Consent; recovery by LivenessSettle |

## Owner decisions (closed in ESCROW-2.1)

The ESCROW-2 adversarial review found five places where the frozen documents
contradicted themselves. The owner decided each one; `tests/closed_decisions.rs`
pins the decided behaviour, and the project report
`claude/ESCROW2.1_CORRECTIVE_PASS_2026-09-25.md` gives the detail.

1. **OD-ESC2-1 — a pause never traps funds.** `LivenessSettle` also works from
   SETTLEABLE once `window_end + liveness_window` has passed, paused or not. If
   the stored settlement's signer key is not compromised it is paid (SETTLED);
   otherwise the game falls back to the highest checkpoint under a
   non-compromised key (SETTLEABLE again, consents reset, fresh window) or, with
   none, refunds every net deposit (CANCELLED).
2. **OD-ESC2-2 — emergency rotation.** Pause → `RetireSignerKey(old,
   compromised: true)` → `AddSignerKey(new)` → post a fresh `Checkpoint` while
   still paused → Unpause. `Checkpoint` works while paused; `Settle`, `Consent`
   and `Finalize` stay paused.
3. **OD-ESC2-3 — compromised evidence loses sequence authority.** A new
   Checkpoint or Settle must exceed the game's *trusted* sequence: the highest
   seq among its evidence whose signer key is not compromised
   (`GameResponse::trusted_seq`, also the value ANNUL signatures sign). The raw
   maximum `last_seq` is kept for audit only. A resolver `Replace` must exceed
   only the trusted checkpoint floor, so the disputed terminal's own log position
   (or any earlier one above that floor) is a legal correction.
4. **OD-ESC2-4 — checkpoint and liveness in one transaction.**
   `LivenessSettle` from IN_PROGRESS may carry a newer signed checkpoint.
   Eligibility is decided on the game before it; the checkpoint is validated
   exactly like `Checkpoint`, promoted atomically, and does not restart the
   liveness clock (an ordinary `Checkpoint` still does). The field is optional,
   so ESCROW-2 JSON still decodes.
5. **OD-ESC2-5 — resolver frozen per game.** A game adopts `CONFIG.resolver` at
   `Start`; only that address may `Resolve` it. `SetResolver` affects games
   started afterwards only.

Required hardening in the same pass: **consent keys are unique within a game.**
`Join` and `SetConsentKey` refuse another seat's current key
(`ConsentKeyInUse`); setting one's own current key again is a no-op. A real
rotation also withdraws the seat's recorded consent to the stored settlement, so
a key that consented for one seat and then moves to another still fills one seat
only: N-of-N consent needs N distinct registered keys. It cannot stop a seat's
own wallet from delegating, for example by registering a key someone else
controls, or the second public key recoverable from another seat's ECDSA
signature (which that one signature also satisfies). Only binding the seat into
the frozen CONSENT/ANNUL digests or a proof of possession would close that.

## Compromised settlements lose payout authority (ESCROW-2.2)

Once the signer key of a stored settlement is marked compromised, no ordinary
path pays that settlement. It stays on record as evidence only.

* `Finalize` refuses with `CompromisedSettlement{key_id}`, before or after the
  window.
* `Consent` refuses every new consent, not only the one that would complete
  N-of-N. The check runs before any signature is verified or any bit is
  recorded, so a refusal moves no funds and changes nothing. Bits recorded
  before the compromise stay as history; nothing can complete them.
* Recovery is unchanged from ESCROW-2.1. From `window_end + liveness_window`,
  `LivenessSettle` (paused or not) promotes the best trusted checkpoint into a
  fresh SETTLEABLE window, or refunds every net deposit when there is none.
  `Challenge` (inside the window) and `AnnulByConsent` remain available.
* The DISPUTED resolver-timeout exit already paid only a trusted settlement.
* A key retired **without** compromise stays trusted: its settlements finalize
  and complete by consent as before.
* A resolver `Uphold` is an adjudicated payout. The frozen resolver policy
  names no key-trust condition, so an `Uphold` of a compromised settlement is
  still possible. The resolver should `Replace` or `Annul` such a dispute
  instead.

## Predeployment gate: wasm, `cosmwasm-check`, gas

The deployable artifact must come from the official optimizer
(`cosmwasm/optimizer:0.16.1`, which builds only `contracts/*` members). Record
the image digest and the artifact's SHA-256. `gasbench/` holds the full recipe.

**Optimizer toolchain (ESCROW-B2).** `cosmwasm/optimizer:0.16.1` builds with
Rust and Cargo 1.81.
* The crate declares `rust-version = "1.81"`, so clippy's `incompatible_msrv`
  lint rejects any std API stabilized later (`Option::is_none_or` is 1.82).
* Before building, Cargo downloads and parses every package the lockfile's
  dependency graph reaches for wasm32 *or* the host, including platform-gated
  and inactive optional ones: 76 packages, of which 41 are compiled. Cargo 1.81
  cannot parse an edition-2024 manifest, so `Cargo.lock` pins `base64ct 1.7.3`
  and `zeroize 1.8.2` (via `cosmwasm-crypto`, host-only). A `cargo update` that
  raises either breaks the optimizer build.

**Acceptance.** Run `scripts/wasm-gate.sh`. It fails when any function
declares more than 90 locals, and it runs every `cosmwasm-check` listed in
`COSMWASM_CHECK`. Use 1.5.x, 2.2.9, 3.0.5 and 3.0.9; at least one must be
2.2.9+ or 3.0.9+.
* cosmwasm-vm 2.2.9 and 3.0.9 (bundled by wasmvm v2.2.8 and v3.0.7) reject any
  function with more than 100 locals.
* Before ESCROW-2.3, `cosmwasm_std::from_json::<state::Game>` reached 135
  locals after `wasm-opt -Os`. The derived visitor of the flat 27-field `Game`
  alone had 100, and the optimizer inlined every nested visitor into it.
  Profile settings (`opt-level`, `lto`) reached 98 at best.
* ESCROW-2.3 stores games in a storage-only shape instead (`src/storage.rs`):
  the same fields, regrouped into four boxed objects.
  * With the same build route, the largest function now declares 63 locals, and
    all four checkers pass.
  * The public `Game`, every message, query and the schema are unchanged.
  * Each stored record is 46 bytes larger (≈ +1.5k SDK gas per game write).
* **No migration:** the stored shape changed without a state migration. That is
  safe only because the contract has never been deployed. A pre-2.3 instance,
  if one ever existed, must not be migrated in place to this code: every game
  would stop loading.

**Gas.** `gasbench/` runs the optimized wasm in cosmwasm-vm 3.0.5 and reports
VM gas plus modelled KV/event gas for every path.
* The whole-`Game` rewrite (≈4.6 KB for 7 seats, ≈138k SDK gas) dominates most
  transactions.
* Paths that compute the trusted sequence grow by ≈3.5k SDK gas per stored
  checkpoint. A `LivenessSettle` that carries a checkpoint scans twice, ≈7k per
  checkpoint.
* The largest modelled execution is that carried-checkpoint liveness exit at the
  64-checkpoint cap: ≈0.67M SDK gas before ante costs.
* Chain figures come only from simulating on the target chain.

## Trust roots and residuals

* The admin controls the signer registry (`AddSignerKey`), so an admin
  compromise can escalate to a settlement-signer compromise. This is disclosed
  for testnet; separating signer-registry governance from the admin is a
  **mainnet security gate**. Because a game adopts its resolver at `Start`, a
  compromised admin can also `SetResolver` before a game starts, and players
  cannot withdraw after `Start`.
* The chain-level wasm admin (the code-migration admin set at instantiate) can
  replace the contract code and is the ultimate trust root.
* A compromised stored settlement waits for its SETTLEABLE liveness exit
  (`window_end + liveness_window`) unless a seat challenges it or every seat
  signs an annul. Recovery is delayed, never blocked.
* Emergency rotation: submit `RetireSignerKey{compromised: true}` and the fresh
  checkpoints in one transaction. Otherwise a leaked key can still post between
  `Pause` and the retirement (Checkpoint works while paused), and ANNUL
  signatures given earlier at the trusted sequence the game falls back to become
  valid again until the fresh checkpoint lands (the outcome is a refund).
* `Join` and `SetConsentKey` do not prove possession of the new consent key, so
  a co-seat watching the mempool can register a victim's intended key first and
  make that call fail. A proof-of-possession signature would close this but
  changes the message ABI (ESCROW-3).
* Once a game is eligible, a plain `LivenessSettle` can land before one that
  carries a newer checkpoint; post newer checkpoints before the window closes.
* Resolver tooling: the `Replace` floor is `Checkpoints.liveness_candidate_seq`
  (the best trusted checkpoint), not `GameResponse.trusted_seq`.
