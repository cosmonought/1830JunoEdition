# eighteen-cosmos-escrow (ESCROW-2)

A CosmWasm 1.5 settlement escrow for Juno money rooms. It is a vault, a deposit
holder, a roster record, a secp256k1 signature verifier, a settlement/challenge
state machine and a proportional payout calculator. It is **not** a rules
engine, board store, appraiser or replay engine: the TypeScript server is the
only gameplay authority and signs `SettlementPayloadV1` payloads with a
registered settlement key. This crate shares no code with the legacy gameplay
contract at the repository root and cannot be migrated from it.

Design sources: `ESCROW_LIVE_RECONCILIATION_2026-09-25` (as amended, A1–A3) and
`SET0A_NET_WORTH_VALUATION_AUDIT_2026-09-25` rev 2 §21.

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
| `src/helpers.rs` | guards (state → role → pause → rest), payload-vs-game checks, consent verification, `pay_out`, `refund_all` |
| `src/execute/*.rs` | funding (create/join/withdraw/cancel/consent key), play (start/checkpoint/settle/consent/finalize), dispute (challenge/resolve/annul/liveness), admin |
| `src/query.rs` | config, games, seats, checkpoints (with the liveness candidate), signer keys, settlement preview |
| `schema/` | generated JSON schema of every message and response (the ESCROW-3 client ABI) |
| `testdata/` | independent Python vector generator, its output (`payload_vectors_v1.json`), and the SET-0A rev 2 payout goldens |

## Tests

| Suite | Covers |
|---|---|
| `vectors` | byte layout, digests and RFC 6979 signatures reproduced from the Python generator, replayed on chain |
| `golden` | SET-0A P1–P13, Q16 and the 13 case previews, off chain and on chain |
| `funding`, `start`, `consent_key`, `checkpoint`, `settlement`, `challenge`, `resolver`, `liveness`, `annul`, `admin`, `terminal` | each message's rules, refusals and boundaries |
| `matrix` | every execute message × every state × paused/unpaused × six caller roles, against an oracle written from §9.1 |
| `invariants` | the twelve escrow invariants: targeted tests plus a seeded random-sequence checker with an independent payout/refund model |
| `open_decisions` | behaviour pinned where the frozen documents contradict themselves (see below) |

## Open owner decisions

The contract implements the §9.1 transition table literally. The adversarial
review found places where the frozen documents contradict themselves; each is
pinned by a test in `tests/open_decisions.rs` and described in the project
report `claude/ESCROW2_CONTRACT_IMPLEMENTATION_2026-09-25.md`:

1. Pause can hold a SETTLEABLE game indefinitely (Finalize and Consent are
   paused; no liveness exit exists from SETTLEABLE).
2. The §10 emergency rotation re-posts checkpoints while paused, which §9.1
   refuses.
3. A leaked signer key can jam `last_seq` (a forged huge `seq` blocks later
   checkpoints, terminals and resolver Replace).
4. §7.5 case 3's "checkpoint and liveness in one transaction" cannot happen,
   because a checkpoint resets `last_activity`.
5. A compromised admin with an accomplice seat can route a pool (AddSignerKey +
   SetResolver + Uphold), beyond §15's stated residual.
