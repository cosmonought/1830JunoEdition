# ROADMAP 3.2 — remaining work

This is the canonical roadmap: the owner's ROADMAP 3.2, recorded in git on 2026-09-27 after DA-8 (`81fd037`) and the context prune (`68f6baf`).

- The owner governs it. Update this file when a phase closes, is re-scoped or is re-estimated.
- Current state, frozen invariants and the working rules are in `PROJECT_CANONICAL_CONTEXT.md`.
- Each pass's exact scope comes from the owner's brief. The "scope sources" column is where that brief's inputs already live. Paths starting with `claude/` are claude.ai Project docs.

## Completed

| Phase | Status | Record |
|---|---|---|
| 1 — Hosted authority | **COMPLETE** | `claude/LIVE2F_LIVE3D_HOSTED_AUTHORITY_CERTIFICATION_2026-09-27.md` (certified tree `0ae252d`) |
| 2 — Delayed Auction / rules v11 | **COMPLETE** | `claude/DA8_RULES_V11_CLOSURE_2026-09-27.md` (`81fd037`) |
| 2.5 — Context prune | **COMPLETE** | `claude/REPO_CONTEXT_PRUNE_2026-09-27.md` (`68f6baf`) |
| 3A — ESCROW-3A: v11 settlement recertification + money-game hosted prerequisites | **COMPLETE** (the owner gate is pending) | `claude/ESCROW3A_MONEY_GAME_PREREQUISITES_2026-09-27.md` |
| 3B — ESCROW-3B: Juno financial backend, durable intents, signing/submission, checkpoints, reversible roster freeze | **COMPLETE** (owner-certified) | `claude/ESCROW3B_JUNO_BACKEND_2026-09-27.md` |
| 3B+ — ESCROW-JOIN: `Join` cryptographically admission-gated by the contract (escrow 2.0.0, canonical wasm `5ecc3022…09e8`); the junk-Join production blocker closed | **COMPLETE** (the owner gate is pending) | `claude/ESCROW_JOIN_ADMISSION_SECURITY_REPAIR_2026-09-28.md` |
| 3 (last pass) — ESCROW-4: Keplr ADR-036 wallet proof, the Join admission wired, W-13 CreateGame binding, R-J1, chain-only funding, Start, browser-held consent keys, the CONSENT/ANNUL relay, the settlement UX, "Your deposits"; financial protocol 3, money GameRecords `record_schema 2`; money tables behind the operator's non-mainnet switch (production fail-closed until LIVE-5's KMS) | **COMPLETE** (owner broad gate GREEN relative to the repository baseline) | `claude/ESCROW4_KEPLR_WALLET_CONSENT_2026-09-28.md` |

## Remaining, in dependency order

| Phase | Scope | Estimate | Scope sources |
|---|---|---|---|
| ~~**3 — Escrow money-game path**~~ | **COMPLETE:** 3A → 3B → ESCROW-JOIN → ESCROW-4 (above; the owner gates are pending) | — | |
| **4 — LIVE-4 / LIVE-5 / LIVE-6** (**next**) | The AWS architecture. LIVE-4: RNG and the compatibility tuple. LIVE-5: AWS/DynamoDB stores, and the KMS clients for the relayer, settlement and admission keys plus shared stores for the money layer's in-memory state (ESCROW-4 §19). LIVE-6: certification | **~30–46 h** | `claude/LIVE4_COMPATIBILITY_CONTINUATION_PREFLIGHT_2026-09-28.md`; ESCROW-4 §19–20; `claude/LIVE_MULTIPLAYER_AWS_ARCHITECTURE_AUDIT_2026-09-25.md` §25; LIVE-3 design §15, §20.3, FI-1…29 |
| **5 — Junox end-to-end** | Full testnet games on the canonical artifact (escrow 2.0.0, `5ecc3022…09e8`; instantiate it fresh — a 1.0.0 `b263277a…` instance is never migrated or used for money): fast path, window path, challenge → resolve, consent annul, liveness settle, key rotation (settlement and admission keys), pause — played through ESCROW-4's UI with real Keplr (its §14 matrix). Measure gas | **~12–20 h** | ESCROW-1 audit §28 ("ESCROW-5"); ESCROW-1.5 §17; ESCROW-4 §19 |
| **6 — Rust retirement** | Delete the legacy crate (RR 2C) after the Junox proof. The escrow artifact rebuilt afterwards must be **byte-identical** | **~6–10 h** | `claude/RUST_RETIREMENT_AUDIT_2026-09-26.md` |
| **7 — Frontend structural cleanup** | Scope set by the owner's brief | **~12–20 h** | The backlog's deferred structural items (e.g. S6-13, S10-7, S10-14); check their status first |
| **8 — Production repo extraction** | Scope set by the owner's brief | **~8–12 h** | — |
| **9 — UI/UX backlog consolidation** | Merge into one prioritized list | **~3–5 h** | `RULES_HARDENING_BACKLOG.md` Part C; `VISUAL_FLOURISH_BACKLOG.md` |
| **10 — UI/UX / visual polish** | Execute the consolidated list | **~28–45 h** | The Phase 9 output |
| **11 — Near-production playtest** | Playtest in near-production conditions | **~8–12 h** | `PLAYTEST_TRANSPORT.md`, `PLAYTEST_NGROK.md` |
| **12 — Release hardening** | Scope set by the owner's brief | **~20–32 h** | e.g. backlog S10-12 (owner-authored release items) |

**Remaining total, Phases 4–12: ~127–202 h** (Phase 3's share, ~22–34 h, is done). Phases 2 and 3 are complete and are not counted.

## Parked

- **Gno (GNOLAND-2…8)** stays parked until Juno is live (after Phase 5) and the Gno maturity gate is met.
- The chain-neutral interface is already in place (`b804150`), and Juno is the only production backend.
- Reference: `claude/GNOLAND0_ESCROW_FEASIBILITY_2026-09-26.md` and `claude/GNOLAND1_CHAIN_NEUTRAL_ESCROW_INTERFACE_2026-09-26.md`.
