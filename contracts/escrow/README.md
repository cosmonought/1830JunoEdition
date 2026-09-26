# eighteen-cosmos-escrow (ESCROW-2, corrected by ESCROW-2.1)

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
| `src/query.rs` | config, games (with `trusted_seq` and every open deadline), seats, checkpoints (with the liveness candidate), signer keys, settlement preview |
| `schema/` | generated JSON schema of every message and response (the ESCROW-3 client ABI) |
| `testdata/` | independent Python vector generator, its output (`payload_vectors_v1.json`), and the SET-0A rev 2 payout goldens |

## Tests

| Suite | Covers |
|---|---|
| `vectors` | byte layout, digests and RFC 6979 signatures reproduced from the Python generator, replayed on chain |
| `golden` | SET-0A P1–P13, Q16 and the 13 case previews, off chain and on chain |
| `funding`, `start`, `consent_key`, `checkpoint`, `settlement`, `challenge`, `resolver`, `liveness`, `annul`, `admin`, `terminal` | each message's rules, refusals and boundaries |
| `matrix` | every execute message × every state × paused/unpaused × six caller roles, against an oracle written from §9.1 as amended by the closed decisions |
| `invariants` | the sixteen escrow invariants: targeted tests plus a seeded random-sequence checker with an independent payout/refund model, which also runs the emergency rotation and finally drains every live game under a permanent pause |
| `closed_decisions` | regressions for OD-ESC2-1…5 and consent-key uniqueness (see below) |

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

## Trust roots and residuals

* The admin controls the signer registry (`AddSignerKey`), so an admin
  compromise can escalate to a settlement-signer compromise. This is disclosed
  for testnet; separating signer-registry governance from the admin is a
  **mainnet security gate**. Because a game adopts its resolver at `Start`, a
  compromised admin can also `SetResolver` before a game starts, and players
  cannot withdraw after `Start`.
* The chain-level wasm admin (the code-migration admin set at instantiate) can
  replace the contract code and is the ultimate trust root.
* `Finalize` still pays a stored settlement whose signer key was marked
  compromised after it was accepted, once its challenge window has closed. Keep
  the contract paused until such games have been challenged or have reached
  their SETTLEABLE liveness exit (which does not pay a compromised settlement).
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
