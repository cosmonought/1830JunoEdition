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

## Remaining, in dependency order

| Phase | Scope | Estimate | Scope sources |
|---|---|---|---|
| **3 — Escrow money-game path** | Three passes, run in this order: 3A → 3B → 4. **3A is complete.** | **~22–34 h** (3A included) | |
| ↳ ESCROW-3B (**next**) | Juno backend, signing and durable intents: transport, KMS signer, `SigningJournal`, `EscrowService`, and intents persisted before broadcast. It builds on 3A's financial lifecycle (after `intent-prepared`), the continuation identity, the checkpoint policy and the wallet-ticket ledger | (in Phase 3) | ESCROW-3A §19; GNOLAND-1 §19–23 (O-1…O-10); SET-0C §18; ESCROW-B2 pins |
| ↳ ESCROW-4 | Keplr and wallet consent; multi-device authorization. It uses 3A's sensitive-action re-authentication (`hasSensitiveAuth`) and the ticket ledger | (in Phase 3) | ESCROW-3A §19; GNOLAND-1 F4; INTEGRATION-1 F-3 |
| **4 — LIVE-4 / LIVE-5 / LIVE-6** | The AWS architecture. LIVE-4: RNG and the compatibility tuple. LIVE-5: AWS/DynamoDB stores. LIVE-6: certification | **~30–46 h** | `claude/LIVE_MULTIPLAYER_AWS_ARCHITECTURE_AUDIT_2026-09-25.md` §25; LIVE-3 design §15, §20.3, FI-1…29 |
| **5 — Junox end-to-end** | Full testnet games on the canonical artifact (`b263277a…`): fast path, window path, challenge → resolve, consent annul, liveness settle, key rotation, pause. Measure gas | **~12–20 h** | ESCROW-1 audit §28 ("ESCROW-5"); ESCROW-1.5 §17 |
| **6 — Rust retirement** | Delete the legacy crate (RR 2C) after the Junox proof. The escrow artifact rebuilt afterwards must be **byte-identical** | **~6–10 h** | `claude/RUST_RETIREMENT_AUDIT_2026-09-26.md` |
| **7 — Frontend structural cleanup** | Scope set by the owner's brief | **~12–20 h** | The backlog's deferred structural items (e.g. S6-13, S10-7, S10-14); check their status first |
| **8 — Production repo extraction** | Scope set by the owner's brief | **~8–12 h** | — |
| **9 — UI/UX backlog consolidation** | Merge into one prioritized list | **~3–5 h** | `RULES_HARDENING_BACKLOG.md` Part C; `VISUAL_FLOURISH_BACKLOG.md` |
| **10 — UI/UX / visual polish** | Execute the consolidated list | **~28–45 h** | The Phase 9 output |
| **11 — Near-production playtest** | Playtest in near-production conditions | **~8–12 h** | `PLAYTEST_TRANSPORT.md`, `PLAYTEST_NGROK.md` |
| **12 — Release hardening** | Scope set by the owner's brief | **~20–32 h** | e.g. backlog S10-12 (owner-authored release items) |

**Remaining total, Phases 3–12: ~149–236 h.** Phase 2 is complete and is not counted.

## Parked

- **Gno (GNOLAND-2…8)** stays parked until Juno is live (after Phase 5) and the Gno maturity gate is met.
- The chain-neutral interface is already in place (`b804150`), and Juno is the only production backend.
- Reference: `claude/GNOLAND0_ESCROW_FEASIBILITY_2026-09-26.md` and `claude/GNOLAND1_CHAIN_NEUTRAL_ESCROW_INTERFACE_2026-09-26.md`.
