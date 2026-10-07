# eighteen-cosmos-escrow 2.1.0 (ESCROW-2, corrected by ESCROW-2.1 and ESCROW-2.2; storage reshaped by ESCROW-2.3; `Join` admission-gated by ESCROW-JOIN; per-game exit policy and timed remedies by the Phase-3 escrow 2.1.0 passes)

> **Escrow 2.1.0 is source-level work, not a canonical money artifact.** It
> carries the per-game exit policy, the dedicated REMEDY key and the timed
> remedies of the owner decisions of 2026-10-06 (R1, FP4; Project report
> `claude/PHASE3_ESCROW21_TIMED_REMEDY_PASS_2026-10-06.md`). What it does
> NOT contain is the server's action clock: which seat is overdue, the 20/30
> race, voluntary and system pauses, the N−1 vote and outage continuity are
> the **server clock / system-pause lane**, implemented on
> `phase3/preplaytest-final-clocks-remedies` (2026-10-06; INTEGRATED 2026-10-07 as the base of
> `phase3/consolidated-final-preplaytest-integration`, not merged to main;
> `docs/phase3/PHASE3_FINAL_CLOCKS_REMEDIES.md`): the sealed decision, the
> dedicated REMEDY signer port (fail closed when absent), the durable intent
> and the clock lane's remedy gate. No KMS remedy signer is deployed and 2.1.0 is
> not deployed; nothing here is mainnet ready. The 2.1.0 artifact is CERTIFIED
> (2026-10-07, owner-machine official optimizer gate): canonical SHA-256
> `c3bd0618615e0d8688f71860a90f235a796b0152be84e2489ce6639e3a218219`, 641,842 B,
> from `e2a67c3` -- certified, NOT deployed. The deployed money artifact remains
> escrow **2.0.0** (`5ecc3022…09e8`, the JX-1 deployment, untouched) until the
> separate release steps (Junox StoreCode simulation, StoreCode / instantiate,
> the REMEDY KMS signer, the production pin, deployment verification) are done.

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

## Escrow 2.1.0: the per-game exit policy and the timed remedies

Owner policy of 2026-10-05 (Live per-action clock, unanimous Live pause, timed
and No-deadline Async, foreclosure formula) and owner decisions R1 / FP4 of
2026-10-06 (the dedicated REMEDY key and its attestation, financial protocol
4). The chain never sees gameplay actions: `last_activity` moves only on
`Start` and posted checkpoints, so it is not an action clock and nothing in
2.1.0 treats it as one. Every off-chain timing fact enters the contract only as
a signed attestation.

### The policy (`GameTerms.policy`, written once by `CreateGame`)

* **`CreateGame.deadline`** (required, `msg::DeadlineChoice`; no default, so
  escrow 2.0.0 JSON does not decode):
  * `live_action_clock {}` (Live only) → `GamePolicy::TimedRemedyV1`,
    `allowance_secs` 1200 (20:00), `cure_window_secs` 600 (to 30:00);
  * `async_pace { allowance_secs }` (Async only; one of 43200, 86400, 172800,
    259200, 604800 = 12 h / 24 h / 2 d / 3 d / 7 d, else `BadAsyncPace`) →
    `TimedRemedyV1`, `cure_window_secs` 0;
  * `no_deadline {}` (Async only) → `GamePolicy::NoDeadline`;
  * the wrong class for the mode is `DeadlineNotForMode`, before any fund moves.
* `policy: None` means the game was stored by 2.0.0 code (a migrated 2.0.0
  game): it keeps every 2.0.0 path, including the IN_PROGRESS standings
  `LivenessSettle`, and has no remedy, no review and no DISPUTED annulment.
* Nothing changes a game's policy, pace or `review_delay_secs` (7 days,
  `REVIEW_DELAY_SECS`) after `CreateGame`: no admin message, `SetParams`,
  pause, key rotation or migration.
* **2.1.0 supersedes the old standings liveness for its own games.** A 2.1.0
  game refuses `LivenessSettle` while IN_PROGRESS (`LivenessExitRemoved`) at any
  time, paused or not, with or without a carried checkpoint. Where 2.0.0 would
  promote the best trusted checkpoint at a SETTLEABLE / DISPUTED timeout (the
  stored settlement's key compromised), a 2.1.0 game refunds every net deposit
  (`SettleableTimeoutRefund` / `ResolverTimeoutRefund`, bond back). A trusted
  stored result is still paid by those exits, paused or not.

### The REMEDY key (owner decision R1)

* A key class of its own (`Config.remedy_keys`, ids 1…, `REMEDY_KEYS` /
  `REMEDY_PUBKEY_INDEX`), registered at instantiate (`InstantiateMsg.remedy_keys`,
  bounded) or by `AddRemedyKey`, retired by `RetireRemedyKey { key_id,
  compromised }` (escalation only). A remedy key is never a settlement signer
  key or an admission key, nor the reverse (every registry checks the others);
  queries `RemedyKey`, `RemedyKeys`. A migrated 2.0.0 deployment starts with an
  empty registry.
* `compromised` also removes the payout authority of a third-strike
  foreclosure the key attested that is stored and not yet paid (`Finalize` and
  `Consent` refuse it; its SETTLEABLE exit refunds).
* **REMEDY attestation** (`remedy::RemedyAttestation`, 166 bytes, every integer
  fixed-width big-endian):

  ```text
  encode = u8(version=1) ‖ domain(32) ‖ u64(chain_game_id) ‖ u8(remedy) ‖ u8(defaulting_seat)
           ‖ u8(strike) ‖ u64(overdue_epoch) ‖ u64(log_len) ‖ log_hash(32) ‖ u64(allowance_secs)
           ‖ u64(overdue_at) ‖ u64(final_at) ‖ u64(attested_at) ‖ u64(expires_at)
           ‖ evidence_hash(32) ‖ u16(remedy_key_id)
  remedy  = SHA-256("18JUNO/REMEDY/v1" ‖ encode)                   signed by an active REMEDY key
  approve = SHA-256("18JUNO/REMEDY-APPROVE/v1" ‖ domain(32) ‖ u64(chain_game_id) ‖ u8(remedy)
           ‖ u8(defaulting_seat) ‖ u8(strike) ‖ u64(overdue_epoch) ‖ u64(log_len) ‖ log_hash(32)
           ‖ u64(overdue_at) ‖ u64(approve_until) ‖ u8(approving_seat))
                                                                    signed by the consent key the seat
                                                                    held at the attested final_at
  ```

  The settlement domain binds chain, contract, game, roster, rules version,
  variants, ante and mode; the attestation binds the exact log position
  (`seq = 2·log_len + 1` must exceed the game's trusted sequence, so a
  checkpoint past the stall voids it), the remedy, the defaulting seat, the
  strike and overdue epoch, the funded allowance, the overdue / final /
  attestation / expiry times and the hash of the server's clock evidence
  (never interpreted). An approval binds one overdue instance and the approving
  seat's own horizon `approve_until`, and it is JUDGED AT THE ATTESTED
  `final_at` -- never at the block time it lands in (owner ruling, 2026-10-07:
  approvals valid when the decision became final decide it): the attested
  `final_at` must be strictly before `approve_until` (else `ApprovalExpired`),
  and the signature must verify under the consent key the seat held AT
  `final_at` (a `SetConsentKey` whose block time is at or before `final_at`
  voids it; one after it changes nothing). So a sealed decision lands however
  late -- through the approvals' later expiry, a later key rotation, an outage,
  a re-attestation (which keeps `final_at`) -- and only that decision. The
  replaced keys of a `TimedRemedyV1` game rotated while IN_PROGRESS are kept,
  with their retirement block time, in a separate uncapped history
  (`retired_consent_keys`, read only by `SubmitRemedy`; never part of the game
  record), queryable as `ConsentKeyAt { chain_game_id, seat_index, at }`. The
  signed bytes are those of REMEDY-APPROVE/v1, unchanged; no version moved.
  Every tag differs from every other, so no
  signature made for one purpose verifies for another. Cross-language vectors:
  `testdata/remedy_vectors_v1.json` (independent Python generator
  `gen_remedy_vectors.py`; 42 vectors, 41 executed on chain by
  `tests/remedy_vectors.rs`; TypeScript `frontend/src/utils/escrowRemedyVectors.test.ts`).
* **Bearer life:** `final_at ≤ attested_at ≤ block time < expires_at ≤
  attested_at + 3600` (`MAX_REMEDY_TTL_SECS`). A final remedy that did not land
  is attested again (a fresh `attested_at`), never extended. No seat is overdue
  before one allowance has run since `Start` (`overdue_at ≥ started_at +
  allowance_secs`).
* The old settlement-payload reasons Forfeit / Clemency are **not** repurposed:
  no remedy is a `SettlementPayloadV1`, and the settlement codec (18JUNO/v1) and
  every 2.0.0 digest are unchanged.

### `SubmitRemedy { chain_game_id, attestation, signature, approvals }` (anyone relays)

Check order: no funds → game → IN_PROGRESS → `TimedRemedyV1` → remedy kind →
pause (foreclosing kinds) → shape against the game and its terms → finality,
attestation time and expiry against block time → sequence → remedy key →
signature → approvals (each: seat range, not the defaulter, no duplicate,
`final_at < approve_until`, signature under the seat's key at `final_at`; then
all N−1). A refusal changes nothing.

| remedy | mode | strike | final_at | approvals | outcome |
|---|---|---|---|---|---|
| 1 `LiveTimeoutAnnul` | live | 1, 2 | ≥ overdue_at + 600 | none | refund every net deposit, ANNULLED (`RemedyTimeoutAnnul`) |
| 2 `LiveForeclose` | live | 1, 2 | ≥ overdue_at + 600 | all N−1 | foreclosure, SETTLED (`RemedyForeclosure`) |
| 3 `LiveStrike3Foreclose` | live | 3 | = overdue_at (20:00) | none | foreclosure stored as a challengeable settlement, SETTLEABLE |
| 4 `AsyncAnnul` | async | 0 | ≥ overdue_at | all N−1 | refund every net deposit, ANNULLED (`RemedyAnnul`) |
| 5 `AsyncForeclose` | async | 0 | ≥ overdue_at | all N−1 | foreclosure, SETTLED (`RemedyForeclosure`) |

* **Live first / second overdue.** The seat's 20:00 allowance runs out; it may
  cure until 30:00. Uncured at 30:00 (later only by exactly the time a
  voluntary or system pause froze the cure window — the clock evidence accounts
  for it; never sooner): the neutral TimeoutAnnul (remedy key alone), or the
  foreclosure if every other seat approved it (N−1).
* **Live third overdue.** At the 20:00 expiry (no cure window) the foreclosure
  is stored as a settlement (`SettlementSource::RemedyStrike3`: kind Terminal,
  weight 0 for the defaulter and 1 for every other seat) and the game is
  SETTLEABLE for the game's challenge window. The defaulter (any seat) may
  `Challenge` with the bond; the game's resolver may only `Uphold` (the
  foreclosure is paid) or `Annul` (neutral refund) — `Replace` is refused
  (`RemedySettlementNotReplaceable`) and gameplay never reopens. Unchallenged,
  `Finalize` or unanimous `Consent` pays it; the SETTLEABLE / DISPUTED timeouts
  pay it unless its remedy key was marked compromised (then they refund).
* **Timed Async.** Overdue at the pace; the remedy (neutral annulment or
  foreclosure) needs every non-defaulting seat's approval and is final the
  moment that consensus completes — no extra timer, no grace period. A cure
  before the consensus completes ends the instance (the approvals bind it).
* **No-deadline.** No overdue, no ordinary timeout: `SubmitRemedy` is refused
  (`RemedyNotAvailable`); it ends by completion, unanimous annulment or the
  exceptional review.
* **Foreclosure arithmetic** (`payout::foreclosure_split`): seat D gets 0; every
  other seat its own net deposit plus `⌊net_D / (N − 1)⌋`; the remainder
  (≤ N − 2 base units) is dust to the game's **snapshotted treasury** (no
  seat-based remainder preference). Fees (taken on every deposit) and gas are
  never refunded or re-created; no remedy carries an address or an amount.
* Every remedy needs IN_PROGRESS and ends it, so at most one takes effect per
  game; `Game.remedy` (`RemedyRecord`) records the one that did (kind, seat,
  strike, epoch, position, times incl. `attested_at`, key id, REMEDY digest,
  approvals bitmap).

### Universal unanimous neutral annulment and the exceptional review

* **`AnnulByConsent`** (N-of-N over `annul = SHA-256("18JUNO/ANNUL/v1" ‖ domain
  ‖ u64(trusted_seq))`) works in every non-terminal escrow-held state of a
  2.1.0 game: IN_PROGRESS, SETTLEABLE and **DISPUTED** (the challenger's bond
  goes back to the challenger), paused or not; it supersedes any pending
  remedy. FUNDING / FUNDED funds leave by `Withdraw` / `Cancel` (also paused).
  A 2.0.0-stored game keeps its 2.0.0 states (IN_PROGRESS, SETTLEABLE).
* **The 7-day exceptional review** (every IN_PROGRESS 2.1.0 game: Timed and
  No-deadline): `RequestReview` by a seated wallet records the first request
  (seat, time, the trusted sequence then); an accepted checkpoint past that
  sequence withdraws it. `ReviewAnnul { chain_game_id, requested_at }` by the
  game's resolver only, from `requested_at + 7 days`, refunds every net deposit
  (route `ReviewAnnul`): neutral only — no payload, no amounts, no address. The
  evidence bar (death, permanent abandonment, lost access; for timed games also
  a catastrophic remedy-system failure) is governance policy, off chain.
* **A resolver never holds a seat in a game it would judge.** `Start` refuses a
  2.1.0 game whose seats include the current resolver (`ResolverIsSeated`; the
  game stays FUNDED, where every deposit can still leave, also while paused,
  until a seat leaves or the admin names another resolver); `Resolve`,
  `RequestReview` and `ReviewAnnul` keep their own refusals as a second line.

### Pause, outages and system pauses

* **The contract cannot detect an AWS outage** and does not try. A system pause
  and a voluntary pause are the server lane's: the server freezes the clock,
  attests nothing for the frozen time, and a remedy is final later by exactly
  the frozen time. A stale (pre-outage) attestation cannot execute: it expires
  one hour after its attestation time, a checkpoint past the stall voids it,
  and its evidence hash is bound.
* **Routes while the escrow is admin-paused** (`Config.paused`):

  | state | works while paused | waits for Unpause |
  |---|---|---|
  | FUNDING / FUNDED | `Withdraw`, `Cancel`, `SetConsentKey` | `CreateGame`, `Join`, `Start` |
  | IN_PROGRESS (2.1.0) | `Checkpoint`, neutral `SubmitRemedy` (1, 4), `AnnulByConsent`, `RequestReview`, `ReviewAnnul`, `SetConsentKey` | `Settle`, foreclosing `SubmitRemedy` (2, 3, 5) |
  | SETTLEABLE | `Challenge`, `AnnulByConsent`, the `window_end + liveness_window` exit | `Finalize`, `Consent` |
  | DISPUTED | `Resolve`, `AnnulByConsent` (bond back), the resolver-timeout exit | — |

  So an admin pause never traps funds (a neutral exit always exists), never
  manufactures a foreclosure (no foreclosing remedy enters while paused) and
  never revives the standings exit. A foreclosure that became final during a
  pause is attested again after it -- the same decision, the same `final_at` --
  and lands whenever the pause ends: its approvals are judged at `final_at`,
  never at the block time (owner ruling, 2026-10-07), so neither their later
  expiry nor a later key rotation stops it. The server never asks the seats to
  approve again and never falls back to the neutral remedy
  (`docs/phase3/PHASE3_FINAL_CLOCKS_REMEDIES.md` §3, §8).
* **OD-ESC2-1 narrowed, OD-ESC-4 narrowed.** An indefinite admin pause blocks
  `Settle` and every foreclosure; IN_PROGRESS 2.1.0 games then leave only
  neutrally (remedy 1 / 4, unanimity, review). OD-ESC-4 ("never force-refund")
  is narrowed only by the 2.1.0 remedies: the remedy key may end a Live game
  neutrally (remedy 1) on an attested 30:00 expiry; there is still no
  arbitrary admin or operator withdrawal power.

### Superseded for 2.1.0 games (2.0.0 unchanged)

* D-12's "no unilateral exit after the deal, 14-day liveness" and OD-ESC-C's
  14-day IN_PROGRESS liveness window: replaced by the timed remedies, the
  universal annulment and the review (the window still bounds the SETTLEABLE
  exit).
* ESCROW-3B's "a stalled game pays by its last appraisal" (the IN_PROGRESS
  standings exit): removed; a stall is cured, remedied, annulled or reviewed.
* A 2.0.0 game, a 2.0.0 deployment (JX-1) and every 2.0.0 fixture and vector
  are unchanged.

### Migration

2.0.0 → 2.1.0 needs no state migration: the new fields read as absent / 0 and
the remedy registry starts empty. The JX-1 2.0.0 instance has no wasm admin and
can never be migrated: 2.1.0 is a new instance, after draining the 2.0.0 money
games.

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
| `src/crypto.rs` | `18JUNO/{DOMAIN,ROSTER,SETTLE,CONSENT,ANNUL,JOIN,REMEDY,REMEDY-APPROVE}/v1` digests, low-s check, compressed keys |
| `src/remedy.rs` | the 166-byte REMEDY attestation: strict encode / decode and the JSON wire conversion (escrow 2.1.0) |
| `src/payout.rs` | `floor(pool·wᵢ/Σw)` in `Uint256`, checked downcast, dust; subsidy and bond arithmetic |
| `src/helpers.rs` | guards (state → role → pause → rest), payload-vs-game checks, the trusted sequence floor, consent-key uniqueness and verification, `pay_out`, `refund_all` |
| `src/execute/*.rs` | funding (create/join/withdraw/cancel/consent key), play (start/checkpoint/settle/consent/finalize), dispute (challenge/resolve/annul/liveness/review), remedy (`SubmitRemedy`), admin (incl. the remedy-key registry) |
| `src/storage.rs` | the storage-only `StoredGame` shape under `games`: private map, lossless `Game` conversions, and the only read/write/range paths (ESCROW-2.3) |
| `src/query.rs` | config, games (with `trusted_seq` and every open deadline), seats, checkpoints (with the liveness candidate), signer keys, settlement preview |
| `schema/` | generated JSON schema of every message and response (the ESCROW-3 client ABI) |
| `testdata/` | independent Python vector generators and their frozen output (`payload_vectors_v1.json`; `join_admission_vectors_v1.json`, ESCROW-JOIN; `remedy_vectors_v1.json`, escrow 2.1.0), and the SET-0A rev 2 payout goldens |
| `scripts/` | `wasm-gate.sh` (optimizer build, ≤ 90 locals per function, every `cosmwasm-check`) and `wasm_locals.py` (the per-function local count) |
| `gasbench/` | stand-alone gas harness that runs the optimized wasm in cosmwasm-vm 3.0.5 (own workspace and lockfile; see its README) |

## Tests

| Suite | Covers |
|---|---|
| `vectors` | byte layout, digests and RFC 6979 signatures reproduced from the Python generator, replayed on chain |
| `golden` | SET-0A P1–P13, Q16 and the 13 case previews, off chain and on chain |
| `set0c_vectors` | SET-0C: the TypeScript builder's vectors (`frontend/src/utils/__fixtures__/settlement/settlementPayloadVectorsV1.json`) re-derived by the crate — domains, roster hashes, payload bytes, SETTLE/CONSENT digests, shape per message, payouts and dust, JSON form — plus the 71 TypeScript mutation outcomes and single-byte decoder classification |
| `funding`, `start`, `consent_key`, `checkpoint`, `settlement`, `challenge`, `resolver`, `liveness`, `annul`, `admin`, `terminal` | each message's rules, refusals and boundaries (`liveness`: the 2.0.0 IN_PROGRESS exit, on games stored in the 2.0.0 shape) |
| `matrix` | every execute message × every state × paused/unpaused × six caller roles, against an oracle written from §9.1 as amended by the closed decisions and the 2.1.0 policy (TimedRemedyV1, No-deadline and 2.0.0-shaped fixtures; RequestReview / ReviewAnnul / SubmitRemedy rows) |
| `invariants` | the twenty escrow invariants (18–19: the 2.1.0 policy and review; 20: the timed remedies): targeted tests plus a seeded random-sequence checker with an independent payout/refund model and an independent `SubmitRemedy` model (every refusal predicted in the contract's check order, 19 mutation classes) over a mix of Live, Timed Async, No-deadline and 2.0.0-shaped games, which also runs the emergency rotation, remedy-key rotation and compromise, and finally drains every live game under a permanent pause; a remedy-focused run covers every remedy kind, every refusal label and every way a third strike closes |
| `escrow21` | escrow 2.1.0: the deadline class at CreateGame and its freeze; the IN_PROGRESS exit refused at any time, paused or not, with or without a carried checkpoint; No-deadline never inactivity-settled; trusted results still paid; compromised settlements refunded, never a checkpoint; the 7-day review (only the game's resolver, only after a seated request, only IN_PROGRESS, only the neutral refund, no payout fields, bound to its request); no game starts with a seated resolver; a migrated 2.0.0 game keeps its 2.0.0 exit; the foreclosure formula against an independent model |
| `remedy` | escrow 2.1.0 timed remedies: key-class separation and registry; every attested field bound; cross-game / cross-instance refusal; at most once; expiry, TTL and the attestation time; pre-outage attestations; staleness by checkpoint; retired and compromised keys; the Live 20/30 shape (a paused cure window final later, never earlier); N−1 approvals (defaulter, duplicate, rotated key, out of range, other instance, other horizon, expired horizon); the third strike (window, challenge, Uphold / Annul only, timeouts, compromise); Async immediate on N−1; No-deadline and 2.0.0 refused; pause blocks foreclosure only; no address or amount; treasury dust; the universal annulment in every non-terminal state |
| `remedy_vectors` | the Python generator's REMEDY encodings, digests, approvals and verdicts reproduced byte for byte, then every replayable vector executed on chain with the recorded verdict |
| `closed_decisions` | regressions for OD-ESC2-1…5 and consent-key uniqueness (see below) |
| `compromised_settlement` | ESCROW-2.2: a stored settlement under a compromised signer key is never paid by Finalize or Consent; recovery by LivenessSettle |
| `join_admission` | ESCROW-JOIN: a Join without the admission for its own sender is refused and moves nothing (random wallet, copied ticket, copied admission, other game, changed ticket or expiry, malformed/high-s/foreign signatures, expiry boundary, rotation, key separation); every other Join rule unchanged |
| `join_admission_vectors` | ESCROW-JOIN: the Python generator's JOIN preimages, digests and verdicts reproduced byte for byte, then every vector replayed on chain (valid ones seat their wallet; mutated or copied ones are refused and move nothing), plus the TypeScript server's exact wire form |

## Join admission (escrow 2.0.0, ESCROW-JOIN)

Before 2.0.0 `Join` checked only the ticket's 32-byte shape, so any wallet that
paid the exact ante could take a seat, including with a ticket copied from an
honest player's visible `Join` (the ESCROW-3B junk-Join production blocker).
`Join` now carries the hosted server's **admission**:

```text
Join { chain_game_id, consent_pubkey, join_ticket, admission: { expires_at: Uint64, signature: 64-byte r‖s } }

join = SHA-256("18JUNO/JOIN/v1" ‖ u16(len) ‖ chain_id ‖ u16(len) ‖ contract_addr ‖ u64(chain_game_id)
               ‖ u16(len) ‖ wallet ‖ join_ticket(32) ‖ u64(expires_at))
```

* `chain_id` and `contract_addr` are the environment's, and `wallet` is the
  transaction's own sender (`info.sender`), so an admission copied into another
  wallet's `Join`, or replayed on another game, contract or chain, never
  verifies. A ticket copied without its admission seats nobody.
* Checked before anything is written or any fund is accepted: block time
  (whole seconds) must be before `expires_at` (`AdmissionExpired`), then the
  low-s secp256k1 signature must verify under `Config.admission_pubkey`.
  Every signature fault is `InvalidAdmission`.
* Stateless: no nonce is stored. Within its lifetime an admission can re-seat
  the same wallet with the same ticket after a `Withdraw`; the server keeps the
  lifetime short (10 minutes by default) and refuses to supersede a seat's
  ticket while one of its admissions is unexpired.
* `CreateGame` needs no admission: an outsider's own game is simply never bound
  by the server (which requires creator = the host's proven wallet, ESCROW-4).
* **The key.** `InstantiateMsg.admission_pubkey` (33-byte compressed, on the
  curve). The admin replaces it with `SetAdmissionKey`, which takes effect at
  once: an admission signed under the previous key stops verifying, and a
  `Join` still in flight fails without moving funds, so its player asks the
  server again. Seats already taken are untouched. A current **or former**
  admission key can never be registered as a settlement signer key, and a
  current or former signer key can never be the admission key (`ADMISSION_KEYS`
  remembers every admission key the contract has held).
* **Canonical artifact (ESCROW-JOIN, 2026-09-28).** `cosmwasm/optimizer:0.16.1`
  (`sha256:b9c92b29…e69e`, Rust/Cargo 1.81.0, wasm-opt 116), two clean builds
  byte-identical: **SHA-256 `5ecc302221a2dab4bb4f0f71b632f2beeafe9523ebd7b33bd0e94d017b8d09e8`,
  534,085 B**, max 68 locals, all four `cosmwasm-check` versions pass. The
  1.0.0 artifact `b263277a…9296` is historical and must never hold money.
* **Gas** (the committed `gasbench`, cosmwasm-vm 3.0.5): `Join` costs one more
  `secp256k1_verify` (+≈108M VM gas ≈ +771 SDK) and reads a 33-byte-larger
  `Config` (+264 KV): +1,035 contract SDK gas (≈120.7k for seat 2 of 7). Every
  path that reads `Config` grows by ≈290 SDK; `Pause`/`Unpause` by ≈2.95k (they
  rewrite it). The largest modelled execution is unchanged: the
  carried-checkpoint `LivenessSettle` at 64 checkpoints, 669,719.
* **Migration.** 2.0.0 state carries the admission key; 1.x state cannot be
  read by this code. `migrate` therefore refuses any stored version below 2.0.0
  (`MigrateUnsupported`): a 1.x deployment is replaced by instantiating 2.0.0,
  never migrated. No funded game exists on a 1.x artifact.

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
  fresh SETTLEABLE window, or refunds every net deposit when there is none
  (escrow 2.1.0 games always refund). `Challenge` (inside the window) and
  `AnnulByConsent` remain available.
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

**Escrow 2.1.0 canonical artifact (CERTIFIED 2026-10-07, NOT deployed).** The
owner-machine gate built `e2a67c3` twice with `cosmwasm/optimizer:0.16.1`
(digest `b9c92b29…e69e`), byte-identical: SHA-256
`c3bd0618615e0d8688f71860a90f235a796b0152be84e2489ce6639e3a218219`, 641,842 B,
max 80 locals (limit 90); `cosmwasm-check` 1.5.11, 2.2.9, 3.0.5 and 3.0.9 pass;
`scripts/wasm-gate.sh` PASS; gasbench on those bytes: the largest 2.1.0 execute
is Resolve Replace at 64 checkpoints, ≈547k estimated SDK gas. A later source
tree reuses this checksum only if its Wasm build inputs are byte-identical
(the kit's `verify-escrow21-inputs.sh`). The history below is superseded.

**Escrow 2.1.0 (earlier source-branch approximation, superseded).** Without Docker,
an approximation of the optimizer route (`cargo +1.81.0 build --release --lib
--target wasm32-unknown-unknown --locked` with `-C link-arg=-s`, then binaryen
`wasm-opt -Os --signext-lowering`, version 116) gives, for the timed-remedy
source, max **80** locals (limit 90) and 634,892 B (SHA-256 of that
approximation `5990f2a1…6b0`, not a canonical checksum -- and OBSOLETE: it predates the
last owner correction of 2026-10-07, which changed the contract source; at that time no 2.1.0 hash
recorded anywhere was canonical); the same route gives
68 locals for the 2.0.0 source, matching the canonical record, and
`cosmwasm-check` 2.2.9 passes. `gasbench` now benchmarks `SubmitRemedy` (all
five kinds, with 6 approvals where needed, and scaling to 64 checkpoints),
`RequestReview`, `ReviewAnnul` and the DISPUTED `AnnulByConsent`; the largest
remedy is ≈0.53M modelled SDK gas at 64 checkpoints. *(The owner-machine
certification this paragraph called for -- the official `cosmwasm/optimizer:0.16.1` build,
two byte-identical builds, all four `cosmwasm-check` versions and `gasbench` against that
artifact -- is DONE: see the CERTIFIED paragraph above.)*

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
* The largest modelled execution (escrow 2.0.0; on 2.1.0 only a game stored by
  2.0.0 code still has this path) is that carried-checkpoint liveness exit at the
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
  signs an annul. Recovery is delayed, never blocked. (A 2.1.0 game recovers
  by refund, never by a checkpoint.)
* Escrow 2.1.0 review: a compromised or colluding resolver can neutrally annul
  an IN_PROGRESS 2.1.0 game a seat asked to review, once the 7-day delay has
  passed; it cannot pay itself or anyone else, touch a 2.0.0 game, or replace
  a finished result. In a third-strike dispute it can uphold or annul, never
  replace. A settlement signer (honest or leaked) withdraws a pending
  request with any accepted checkpoint beyond the boundary trusted at the
  request, so a malicious server can delay a review indefinitely (the requester
  asks again); it moves no money that way.
* Emergency rotation: submit `RetireSignerKey{compromised: true}` and the fresh
  checkpoints in one transaction. Otherwise a leaked key can still post between
  `Pause` and the retirement (Checkpoint works while paused), and ANNUL
  signatures given earlier at the trusted sequence the game falls back to become
  valid again until the fresh checkpoint lands (the outcome is a refund).
* The join-admission key decides who may take a seat. Its compromise lets an
  attacker seat wallets (griefing a table, as before 2.0.0), but it moves no
  money, starts nothing (the operator's) and settles nothing (the settlement
  key's). The admin can replace it (`SetAdmissionKey`).
* `Join` and `SetConsentKey` do not prove possession of the new consent key, so
  a co-seat watching the mempool can register a victim's intended key first and
  make that call fail. A proof-of-possession signature would close this but
  changes the message ABI (ESCROW-3).
* Once a game is eligible, a plain `LivenessSettle` can land before one that
  carries a newer checkpoint; post newer checkpoints before the window closes.
* Resolver tooling: the `Replace` floor is `Checkpoints.liveness_candidate_seq`
  (the best trusted checkpoint), not `GameResponse.trusted_seq`.
* **Escrow 2.1.0 remedy trust (residuals).**
  * The admin registers remedy keys with immediate effect (`AddRemedyKey`), so
    an admin compromise can escalate to a remedy-key compromise; separating
    that governance from the admin is part of the same mainnet security gate.
  * A compromised REMEDY key alone can: end a Live game neutrally (remedy 1,
    a refund); store a challengeable third-strike foreclosure (remedy 3: the
    defaulter challenges, the resolver annuls; `RetireRemedyKey{compromised}`
    removes its payout authority before payment). With N−1 approvals it can
    use them only for the exact overdue instance they name, with a `final_at`
    before their `approve_until`.
  * Before a checkpoint past the stall reaches the chain, the contract cannot
    tell a cured overdue from an uncured one: the remedy key is trusted for
    that, and the **server lane must post a fencing checkpoint on cure** (an
    obligation of the clock lane). Since approvals are judged at the attested
    `final_at` (owner ruling, 2026-10-07), `approve_until` no longer bounds WHEN
    the approvals of a cured instance could be used: a compromised REMEDY key
    holding them could attest a back-dated `final_at < approve_until` at any
    later time until that fencing checkpoint lands. The binding -- the exact
    instance, plus a `final_at` signed by the REMEDY key -- is the most the chain
    can check; the remaining bound is the fence, so the fencing checkpoint must
    land (the server posts it on cure; tracking it to landing is a residual of
    the clock lane). The contract does not cap the horizon. (The client signs
    Live approvals to the overdue moment + 6 h − 60 s and Async approvals to
    29 days from the server's time; the server accepts an approval only if it
    outlives the decision's final second.)
  * An admin `SetResolver` to a seated wallet delays the `Start` of FUNDED
    2.1.0 games (deposits stay withdrawable and cancellable): denial of service
    only.
  * `SetConsentKey` is not allowed in DISPUTED, so a seat that lost its consent
    key cannot join a DISPUTED unanimous annulment; the dispute still ends by
    the resolver or its timeout.
