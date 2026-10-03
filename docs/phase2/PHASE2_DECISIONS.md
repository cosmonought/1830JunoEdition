# Phase 2 — decision ledger

The owner decisions that shape the Phase-2 live sessions (`PHASE2_LIVE_SESSION_MAP.md`). Append-only: a changed
decision gets a new row that names the one it supersedes.

> "Phase 2" is the owner's live-execution plan (Phase 1 = the single-host migration, Phase 2 = the testnet live sessions,
> Phase 7 = mainnet readiness), not ROADMAP 3.2's phase numbering.

## OD-P2-KR — live key rotation: DEFERRED to Phase 7 (owner decision, 2026-10-03)

> **Phase 2 live key rotation deferred. It remains source/contract certified and must receive live proof during Phase 7
> mainnet readiness before real-value launch.**

**Why (the owner's reasons):**
- source and contract coverage already exists (below);
- a live rotation needs an additional financial key pair (a new `financial_key_sets` label, e.g. `jx1b`, with its own
  settlement and admission keys);
- that adds persistent KMS cost — keys are `prevent_destroy` and bill $1/key-month until a reviewed retirement — and it
  would take the ledger to **7** signing keys, above `infra/aws/COST_BUDGET.json` `max_kms_keys` = 6 (Phase 2 runs with
  3 + the `jx1` pair = 5);
- it is not needed to prove ordinary testnet gameplay.

**What is deferred:** the live settlement / admission key-rotation drills on the JX-1 contract — JX-1B §C.4 step 6
(append a label, `AddSignerKey` → signer key id 2, `RetireSignerKey`, `SetAdmissionKey`, each in its own stopped-host
window because an admin key action makes the running backend `refused` within 60 s). JX-1B §D's matrix line "3
key-rotation games" leaves Phase 2.

**No new KMS key is created in Phase 2** beyond the `jx1` pair JX-1 itself requires.

**Certified in source / contract today (what the deferral relies on):**
- contract (`contracts/escrow/tests/`): `admin.rs` (`signer_keys_are_added_with_increasing_ids`,
  `signer_key_registration_is_validated`, `retirement_escalates_but_never_downgrades`, `the_signer_key_registry_is_bounded`),
  `compromised_settlement.rs` (`emergency_rotation_end_to_end`), `join_admission.rs` (`SetAdmissionKey`: a current or
  former admission key is never a signer key and vice versa; an in-flight Join fails and moves no funds);
  `consent_key.rs` (a seat's consent-key rotation); the gas gate's emergency-rotation rows;
- ledger IaC (`modules/ledger` `terraform test`): `financial_key_sets` is append-only — a second label keeps the first,
  beside a relayer rotation nothing moves, labels validated;
- server: `verifyJunoDeployment` refuses a deployment whose signer registry or admission key disagrees with the
  configuration (registry id = the configured key, active, and no other active key; chain `admission_pubkey` = the
  configured key), re-checked every 60 s while active.

**Phase 7 obligation (before any real-value launch):** a live rotation drill on testnet — a new financial label,
`AddSignerKey` / planned `RetireSignerKey`, `SetAdmissionKey`, each in a stopped-host window, with the backend verified
on the rotated registry and a money game settled under the new key — plus the KMS budget decision that allows the extra
pair (or a reviewed retirement of the `jx1` pair first).

**Related, recorded here for completeness (not a new decision):** relayer-key rotation is also not exercised in Phase 2.
Its live proof was LIVE-6 L6-13, which never ran (LIVE-6 was abandoned at GO-B), and RECON-0
(`docs/RECON0_SOURCE_LINEAGE_2026-10-02.md`) classifies its single-host procedure as "OWNER DECISION REQUIRED (future
slice)". It stays an open Phase-7 readiness item beside OD-P2-KR.

## OD-P2-1 — the JX-1 operator is the single host's configured relayer (owner confirmation REQUIRED before Session 1)

JX-1B decided "r2 remains operator (instantiate with operator = r2; no SetOperator)", on the assumption that L6-13 had
rotated the relayer to r2. In the single-host lineage L6-13 never ran, so no `relayer-r2` key is expected, and creating
one is a new KMS key (excluded above). `JX1_SINGLE_HOST_SETUP.md` §0.3 therefore keeps the decision's intent — operator =
the relayer the server is already configured with, so no `SetOperator` — with `<RELAYER>` read from the configuration at
S0.2 (expected r1, `juno1wev2…tu6`). The relayer must hold ≥ the derived reserve (8.2125 JUNOX at the default gas
policy) before GO-3 and about 15 JUNOX before Session 2. **The owner confirms this before GO-2** (the operator is fixed at
instantiate; changing it later is an admin `SetOperator` in its own stopped window).

## OD-P2-2 — cancel by agreement (consent annul) is proven live in Session 4 (procedure added 2026-10-03)

One fresh 2-seat live table at the minimum ante, annulled from IN_PROGRESS right after the deal checkpoint
(`CONSENT_ANNUL_LIVE_PROCEDURE.md`). The SETTLEABLE variant and the stale-signature case stay source / contract proven.
JX-1B §D's matrix line "1 annul" is this test.

## Carried decisions (unchanged; listed so the sessions read one place)

| Decision | Source |
|---|---|
| Fresh JX-1 settlement and admission keys; reusing the current ones is forbidden | JX-1B §C.1; JX-1K |
| Code 121 / canonical `5ecc3022…09e8`, `--no-admin`, trust 900 / 3600 / 7200, owner-held resolver, dedicated treasury | JX-1B §E, §F; `JX1_SINGLE_HOST_SETUP.md` §0.1 |
| OD-JX5-1: the JX-4/JX-5 game uses the `short` ($4,500 bank) variant | JX-5A / JX-5B |
| OD-JX5-2: ordinary payout proof = exactly one seat consents, the other does not, then the relayer Finalizes after the 900 s window | JX-5B |
| JX-6A: Scenario A = resolver Upholds; Scenario B = resolver timeout (7200 s) by a seat's LivenessSettle; challenge bond 1 JUNOX; Replace only `replace-canonical` | JX-6A |
| OD-JX7-1 (run E, the SETTLEABLE liveness under an admin pause), OD-JX7-2 (wallet reuse), OD-JX7-3 (no live D′) | JX-7A — **owner choices still open** |
| Do not merge `main` until the dedicated closure / integration stage | owner brief |
