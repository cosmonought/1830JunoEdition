# W3-F — Phase-3 closure report (2026-10-10)

**Result: Phase 3 CLOSED.** Phase-4 playtest baseline: `ludum/integration` @ `e63221ae3f308dcbdb89bf67b28929a04099605b`.
Machine-readable record: `phase3_accounting.json` → `w3f_closure`, `phase3_final_integration`,
`ludum_platform_play_integration`, `escrow21_staging_deployment`.

## What the baseline contains

- The consolidated final pre-playtest integration (`phase3/consolidated-final-preplaytest-integration`, `7f8bff24` lineage):
  every Phase-3 slice, the final Play tutorial, the escrow 2.1 release-readiness source and the Ludum governance config.
- The Ludum platform: v1 (frozen contract, ingress, sessions, case, history), v1.1 (published 2026-10-10) and v1.2 (native
  sign-up, sign-in, sign-out and "Confirm it's you" over the one account service).
- The approved Play lobby (`0ccbda95`), Host a game / waiting room with the host's ante editor and the official Keplr assets
  (`03b755a2`).
- The final-integration fixes:
  - `700f35a6`: the host ante race is closed at the source; shared-bar a11y; the Any-count notice; a stale pin.
  - `d6cb1b12`: the read-only Watch copy.
  - `e63221ae`: a stale lobby pin.

## Recorded issues (the owner's brief, part 2)

| Issue | Outcome |
|---|---|
| p3PublicFirst failure | Reproduced. It is a stale pin: Ludum v1.1 added `<LudumConfirmHost />` to `index.tsx`, and the pin now names it. Not a product defect. |
| Two shared-top-bar a11y findings | Both fixed without a redesign. The station drawer's muted text now has 5.4:1 contrast. The Offline dot's label now sits on `role="img"`. axe finds nothing serious or critical in Chrome or Firefox. |
| Host ante-change race | **Server:** an old-ante CreateGame is never bound or shown as funded. It is listed at its true amount and can be cancelled on chain, and the table recovers afterwards. **Genuine client defect, fixed:** Play could broadcast a CreateGame signed at the old ante. It now re-checks the table after Keplr returns and refuses to send, so nothing moves and the player is told plainly. **Residual:** a non-Play client can open a second escrow. It stays unbound and cancellable (the A-4 duplicate design). |
| Any-count ambiguity | With an ante, Any is blocked and the reason is stated under Players. Choosing an exact count clears it. Any is never reinterpreted as Exact. |
| Firefox (Host, waiting room) | Complete: room flow 60/60 and account flow 36/36, the same as Chrome. |

## Testing (part 3)

**Servers and suites**
- Focused server suites: 529/529.
- Affected frontend suites (100 files): all pass. The only exceptions are two CRLF working-tree artifacts that pass on LF sources.
- Ludum: check-scripts, 108 platform tests, and the site build.

**End-to-end runs in Chrome and Firefox (real server, production builds)**
- Room flow: 60/60 in each browser.
- Account flow, both sites: 36/36 in each browser.

**Fixture-only:** the chain was a fake Juno and Keplr was a stand-in that signs locally. **No real Keplr wallet and no real Juno
transaction was used or verified.**

## Closure contract (§11)

Items 1–12 PASS, judged one by one in `w3f_closure.contract`.

**Item 8 (the owner's broad gate):** passed as delegated by the owner's 2026-10-10 release brief. The standing rule forbids
running the full repository suite, so the gate is the focused suites plus both browsers' end-to-end flows. It is **not** the
full suite.

## Phase-4 deferrals (explicit)

1. **EARLY PHASE-4 TASK (mandatory): the Any-count escrow correction.**
   - Escrow 2.1 requires an exact seat count for a money table, so Play blocks Any whenever there is an ante.
   - A corrected escrow version must be certified and deployed before Any is offered with an ante.
   - **Escrow 2.1 itself stays unchanged.**
2. Real-wallet testing on uni-7:
   - funded games: create, join, pending to confirmed, Withdraw, Cancel on Juno, Refund, and the relayer Start;
   - settlement, REMEDY attestations, and disputes / appeals;
   - the live two-player money proof.
3. The host ante race with a real Keplr window.
4. B3 (signed-in WebSocket) and Phase-2 E2. These stay deferred to human playtesting and are never relabelled PASS.
5. Every D row: see [`PHASE4_PLAYTEST_CHECKLIST.md`](PHASE4_PLAYTEST_CHECKLIST.md).
