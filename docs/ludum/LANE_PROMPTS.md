# Ludum — implementation-chat prompts (final)

Paste each prompt into its own fresh Claude Code chat, in the working directory that prompt names.
`docs/ludum/LUDUM_PLATFORM_ARCHITECTURE.md` on branch `ludum/baseline` governs every prompt. Where they differ, its FROZEN
sections (§3, §4, §5, §6, and §9's `LudumPorts`) and §2.1 / §2.4 win.

**Lane order and status:**
- **B1 is Phase-3-critical.**
- A, C and B2 are parallel Ludum-platform lanes and do not gate Phase 3.

## Common rules (every lane)
**Where to work**
- Work only in your assigned worktree and branch (§11).
- Never check out, merge into or push `main` in either repo. Pushing `cosmonought/ludum` `main` publishes the live site.
- Commit locally on your branch. Do not push.

**What you may touch**
- Write only the paths §3 gives your lane.
- Every pre-existing file in the `ludum` repo belongs to the separate Claude Design / Cowork work. That includes the existing
  pages, `design-system/**`, `assets/**` and `README.md`. Read them; never edit them.
- Never deploy or publish. Never run Terraform, AWS, KMS or SSM commands, and never edit `infra/**`.
- Never sign or broadcast a chain transaction. Read-only queries and `simulate` are allowed.

**Testing**
- Run targeted tests only. NEVER run the complete repository suite, which means never bare `npm test`.
- Server, in your worktree:
  1. `cd server && npm ci`, plus `cd frontend && npm ci` once.
  2. `npm run build`.
  3. `node --test --test-concurrency=1 dist/server/src/<path>.test.js …` for your own files and the neighbours named in your
     prompt.
- Frontend: `npx react-app-rewired test --watchAll=false <pattern>`.

**Content rules**
- Do not invent governance contracts, addresses, rules or fees. Use §1.4 and §6, or a live read-only query.
- JUNOX (`Junox`: integer base-unit strings, `ujunox`) and in-game dollars (`InGameMoney`) are separate types. Never read the
  board's `total_juno_pool`.
- Make no change to cookie attributes, session rotation, revocation, step-up, the Authorization Wallet, `GS_ALLOWED_ORIGINS`
  semantics, or any governance configuration.

**Commits and reporting**
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Stop only for a genuine owner decision. Finish with `LANE <X> REPORT: PASS | PARTIAL | BLOCK`, plus:
  - your branch head SHA;
  - files changed, checked against §3;
  - tests run, with their outputs;
  - test files the coordinator must add to `server/package.json`;
  - open questions;
  - deploy steps needed (none performed).

---

## PROMPT B1 — Create Appeal Proposal workflow (PHASE-3-CRITICAL)

Working directory: `C:\Users\Bradshaw\Documents\GitHub\ludum-wt\b1-appeals` (branch `platform/b1-appeals`, from `ludum`
`main` @ `c85b0b6`).

You are LANE B1 of the Ludum platform build: the Phase-3-critical Create Appeal Proposal workflow.
1. Read `C:\Users\Bradshaw\Documents\GitHub\1830Juno-wt\baseline\docs\ludum\LUDUM_PLATFORM_ARCHITECTURE.md` in full,
   especially §1.4, §2.2, §2.4, §3, §6 and §11.
2. Read the Common rules in `docs\ludum\LANE_PROMPTS.md` next to it.

B1 has no server change and no dependency on Lanes A, C or B2. You write only:
- `disputes/**`
- `governance/**`
- `platform/js/gov*.js`
- `platform/vendor/**`
- `platform/tests/gov*`

**1. Vendor cosmjs**
- `platform/vendor/`: a pinned, self-hosted cosmjs browser bundle, in the same version family as
  `C:\Users\Bradshaw\Documents\GitHub\1830Juno-wt\baseline\frontend\package.json`.
- Record the version, the build method and the sha256 in `platform/vendor/README.md`. No CDN.

**2. `platform/js/gov.js` (the `LudumGov` global)**
- Pins: the §1.4 table, chain id `uni-7`, REST `https://juno.api.t.stavr.tech`, denom `ujunox`.
- On load, query the DAO core's `proposal_modules` and `voting_module`. On any mismatch with the pins, refuse, show
  "configuration mismatch", and offer no action.
- Keplr connect.
- Governor check: cw4 `member{addr}` weight > 0 **and** pre-propose `can_propose{address}` true. That is the only source of
  governance powers. Website moderators and conduct reviewers get nothing.
- Builders must produce §6 byte for byte:
  - `propose`, sent to the pre-propose contract, with `funds: []`;
  - `vote`, `execute` and `close`, sent to the proposal module.

  Every transaction is `simulate`d before Keplr is asked to sign.
- Link-by-decoding (§6): a proposal belongs to game G only if it holds exactly one `wasm.execute` to the pinned escrow,
  carrying `resolve` with `chain_game_id == G`.
- Deadline guard: refuse to prefill a proposal when `resolverTimeoutAt − now < max_voting_period + 24 h`, and explain why.
- Framing guard (§2.4): enable the action buttons only when `window.top === window`, or when `location.ancestorOrigins`
  shows every ancestor is a family origin. Otherwise show "Open in its own tab".

**3. Pages**
Use `design-system/css/ludum.css` and the existing components as they are. Each page starts its `<head>` with the §2.4 meta
CSP exactly as written. No inline `<script>`: call `Ludum.enhance()` from `platform/js/gov-page.js`. The radio include stays,
as on every Ludum page.
- `disputes/index.html`, the register:
  - Page through escrow `games` (limit 30) and keep `disputed`. Also list resolved disputes.
  - For each, show the chain game id, the state, `resolver_timeout_at` with a countdown, and the linked proposal.
- `disputes/case/index.html?id=<chainGameId>`, the case page:
  - Chain facts: the seats (index and wallet), the challenger, the bond, `evidence_hash`, `disputed_at`, the deadlines, the
    stored settlement and the latest checkpoint.
  - "Create appeal proposal", for governors only: Uphold or Annul. Show Replace but keep it **disabled**, because it needs a
    `SettlementPayloadV1` builder and owner sign-off. Offer an "also vote yes" opt-in, unchecked by default.
- `governance/index.html`:
  - Proposals from `reverse_proposals` and `list_votes`: status, tally, decoded msgs, the linked game, and the
    vote / execute / close actions, gated on membership.
- Every displayed value is a chain fact with its read time. If REST is unreachable, show "unavailable"; never show a stale
  value as current.

**4. Tests** (`platform/tests/gov*.test.mjs`, run with `node --test`)
- Golden JSON for every builder against §6, including the base64 `Resolve` for Uphold and Annul.
- A pin mismatch refuses.
- The deadline guard refuses at the boundary.
- Link-by-decoding ignores look-alike proposals: wrong contract, two msgs, a different id, non-`resolve` bodies.
- The framing guard behaves as specified.
- The meta CSP on each new page equals §2.4 exactly.

**5. Manual checks**
- Load the pages locally with `python -m http.server` from the worktree root.
- Confirm there are no CSP violations in the console in Chrome and Firefox, with the radio off and on.
- Confirm Keplr connects under the CSP, and record the browser versions.
- Today the escrow has no games (`next_chain_game_id` 1), so propose cannot be exercised. Record "not exercisable". Do NOT
  create a game, a dispute or a proposal.

---

## PROMPT A — Shared identity and sessions (Ludum platform lane)

Working directories:
- `C:\Users\Bradshaw\Documents\GitHub\1830Juno-wt\lane-a` (branch `ludum/lane-a-identity`, from `ludum/baseline`)
- `C:\Users\Bradshaw\Documents\GitHub\ludum-wt\a-session` (branch `platform/a-session`, from `ludum` `main` @ `c85b0b6`)

You are LANE A of the Ludum platform build.
1. Read `docs/ludum/LUDUM_PLATFORM_ARCHITECTURE.md` in full, especially §1.3, §2.1, §2.4, §3, §5, §8, §9, §10.3 and §11.
2. Read the Common rules in `docs/ludum/LANE_PROMPTS.md`.

The coordinator has already committed step 0 on `ludum/baseline`: `server/src/ludum/{contract,ports,registry}.ts`,
`registry.test.ts`, and the stubs `history/index.ts` and `disputes/index.ts`. Do not edit those files. Lanes C and B2 own the
stubs.

**1. `server/src/ludum/ingress.ts`**
- Implement §2.1 exactly, for the prefix `/gs/api/ludum/v1/` only:
  - the statically answered OPTIONS preflight;
  - exact single-`Origin` matching against `GS_LUDUM_ORIGINS` ∪ `GS_ALLOWED_ORIGINS`;
  - the credentialed-CORS response headers on every allowed-origin response, errors included;
  - `403` with no `Access-Control-*` header otherwise;
  - `application/json` only;
  - a body of at most 1 KiB, closed schema;
  - `405` for other methods;
  - `no-store`;
  - rate limits through the existing `limiter.ts`.
- Do not rely on `Access-Control-Request-*` or `Sec-Fetch-*`, because CloudFront doesn't forward them.
- Authenticate through the existing session verifier.
  - Never rotate a session, never mint one, never `Set-Cookie`.
  - These resolve to `principalId: null`: rotated predecessors (bootstrap-only), revoked, expired, provisional and
    unprofiled sessions, and requests with no cookie.
- Dispatch through `registry.ts`.

**2. `server/src/ludum/session.ts`**
The `session` route returning §5 `SessionResponse`, reusing the data behind `/gs/api/account/me`.

**3. `GS_LUDUM_ORIGINS`** (`server/src/identity/mode.ts`, or the runtime-config reader)
- https-only, exact, no wildcards. Invalid values are refused in production.
- Find a production delivery path that does **not** edit `infra/aws/modules/single-host/templates/server.env.tftpl`. That
  file feeds `user_data` with `user_data_replace_on_change = true`, so editing it would replace the instance.
- Prefer the runtime config document behind `GS_AWS_CONFIG_PARAMETER`.
- If no non-replacing path exists, report BLOCK with the options. Do not edit `infra/**`.

**4. `server/src/ludum/wiring.ts` and one hunk in `server/src/gameServer.ts`**
- Build the real `LudumPorts` (§9): `roomHost`'s record index, the financial store, settlement evidence, and the escrow
  service's chain reads, using quorum where available.
- Dispatch the ludum prefix **before** `handleMoneyHttp`.
- You may add minimal read-only accessors in `rooms` or `escrow` if the wiring needs them. List each one.

**5. Play frontend (`frontend/src/**`)**
- Handle `?ludum=signin&return=<path>`: open the existing sign-in flow. On success, or at once if already signed in, go to
  `https://ludum.netadao.org` + path.
- Only when the path matches `^/[a-z0-9/_-]{0,128}$`. Otherwise stay on Play.
- The Ludum host is a build constant.
- Add a test.

**6. In the `ludum` worktree**
- `platform/js/session.js`, the `LudumSession` global from §5:
  - `whoami`, `api`, `signInUrl` and `PLAY_ORIGIN`;
  - `api` sends exactly the §2.1 client `fetch`.
- `platform/js/page-init.js`: calls `Ludum.enhance()`, so the new pages need no inline script.
- `platform/tools/check-scripts.mjs`: fails on any `<script src>` outside the §2.4 allow-list in any `*.html`, and on any
  inline script in `me/`, `disputes/` or `governance/`.
- `platform/README.md`.
- Do not touch existing pages or `design-system/**`. Header nav links are a later hand-off to the design work.

**7. Tests**
- `server/src/ludum/*.test.ts` must cover **every** §10.3 security assertion, including all the negative CORS, method,
  content-type and session cases.
- Add your ludum test files to `server/package.json`.
- Run them, plus `identity/live2bIdentity`, `identity/p3AccountPolicy`, `identity/p3FinalReviewFixes` and `ludum/registry`.
- Frontend: `sessionBootstrap`, `p3AccountSession`, and your return-to test.
- Run `node platform/tools/check-scripts.mjs` in the `ludum` worktree. It must pass on `main`'s pages as they are.

---

## PROMPT C — Player history and finances (Ludum platform lane)

Working directories:
- `C:\Users\Bradshaw\Documents\GitHub\1830Juno-wt\lane-c` (branch `ludum/lane-c-history`, from `ludum/baseline`)
- `C:\Users\Bradshaw\Documents\GitHub\ludum-wt\c-history` (branch `platform/c-history`, from `ludum` `main` @ `c85b0b6`)

You are LANE C of the Ludum platform build.
1. Read `docs/ludum/LUDUM_PLATFORM_ARCHITECTURE.md` in full, especially §1.5, §2.3, §2.4, §3, §4, §5, §9 and §10.4.
2. Read the Common rules in `docs/ludum/LANE_PROMPTS.md`.

Code only against the committed `server/src/ludum/contract.ts` and `ports.ts`, and never edit them. You own:
- `server/src/ludum/history/**`, including replacing the stub `history/index.ts`, which must export the `games` and `game`
  handlers that `registry.ts` imports;
- `me/**`, `platform/js/history.js` and `platform/tests/history*` in the `ludum` worktree.

**1. `games` handler**
- Collect `ports.records()`, filtered by `ports.seatOf(record, caller.principalId)`.
- Include every status, with no 50 cap.
- Newest first. The opaque cursor is base64url of `{createdAt, gameId}`; the limit is 1–50, default 20.
- A signed-out caller gets `401 signed-out`.
- Document the O(n) scan, and the scale at which an `ACCT#` index becomes necessary. Do not build the index.

**2. `game` handler**
- Answer `404` unless the caller holds a seat. Return §5 `GameDetail`.
- The other seats' display names are allowed. No other account data.

**3. Money: `history/ledger.ts`**
- Build per-seat ledger entries and `net` from the chain `Game` (`ports.chainGame`).
- Derive **each route's** semantics from `contracts/escrow/src/payout.rs`, `state.rs` and `execute/*.rs`:
  - settled
  - annulled
  - cancelled
  - withdrawn during funding
  - uphold (bond forfeit)
  - replace
  - liveness_settle
  - remedy and foreclosure
- A withdrawn seat can vanish from `Game.seats`. When an amount can't be proven, its entry is `unavailable` with a reason.
  Never guess.
- BigInt only. Provenance follows §4. Before a chain outcome exists, use the server-recorded terms and phase, labelled
  `server-recorded` or `pending`. `networkFeesIncluded: false`.

**4. In-game results**
- Money games: rank and final net worth from `ports.terminalEvidence` `totals`, labelled `server-recorded`.
- No-money games: `unavailable`, with the reason "not recorded; replay required".

**5. Tests** (`server/src/ludum/history/*.test.ts`, fake ports plus `fakeJunoChain`)
- Every route above.
- Exact integer `net`.
- A grep test showing no `total_juno_pool` anywhere in `server/src/ludum/**`.
- In-game dollars never appear in a `Junox`.
- Provenance is downgraded whenever an input isn't a chain fact.
- Another account's game answers `404`.
- Run them, plus `escrow/escrow4Money`, `escrow/settlementLifecycle`, `rooms/live2f3dCertification` and `ludum/registry`.
- List your test files for the coordinator. Do not edit `package.json`.

**6. Ludum `me/index.html`**
- The §2.4 meta CSP first in `<head>`. No inline script.
- Profile header from `LudumSession.whoami()`.
- Games ledger (design-system Ledger component) with these columns: product, date, table status, escrow state, ante, net, rank
  and dispute.
- A detail drawer with the entry list.
- A provenance marker on every value.
- JUNOX and in-game dollars in visibly separate columns, never summed.
- A dispute links to `/disputes/case/?id=<chainGameId>`, which is B1's page.
- Until Lane A lands, use a local mock of `LudumSession` from `platform/tests/`.

---

## PROMPT B2 — Server case enrichment (Ludum platform lane)

Working directory: `C:\Users\Bradshaw\Documents\GitHub\1830Juno-wt\lane-b2` (branch `ludum/lane-b2-case`, from
`ludum/baseline`).

You are LANE B2 of the Ludum platform build.
1. Read `docs/ludum/LUDUM_PLATFORM_ARCHITECTURE.md` in full, especially §3, §4, §5 `CaseRecord`, §6 and §9.
2. Read the Common rules in `docs/ludum/LANE_PROMPTS.md`.

You own `server/src/ludum/disputes/**`, including replacing the stub `disputes/index.ts`, which must export the `case`
handler that `registry.ts` imports. Never edit `contract.ts`, `ports.ts` or `registry.ts`.

**The `case` handler**
- It is PUBLIC: `caller.principalId` may be null. It returns §5 `CaseRecord` using `LudumPorts` only, with no display names
  and no account data.
- `chainGameId` is a decimal string. Return `404` when the chain has no such game.
- `evidenceMatches` compares the on-chain `evidence_hash` with the server's own `logHash` of the game log and its
  `terminalStateHashV1` of the terminal board. Those are the two hashes the challenger's device can submit
  (`frontend/src/money/moneyActions.ts:965-970`).
- Provenance follows §4.

**Tests** (fake ports)
- disputed, resolved, not disputed and unknown games;
- each `evidenceMatches` outcome;
- no account data in any output.

Run them, plus `escrow/jx6bDisputeServer`, `escrow/juno/uni7LudumGovernance` and `ludum/registry`. List your test files for
the coordinator.

**The Ludum case-page fetch** happens later. Once the coordinator has integrated B1, a follow-up instruction adds a feature-
checked `LudumSession.api('case', …)` call to B1's `disputes/case/` page, falling back to chain-only. Don't touch the `ludum`
repo in this chat.
