# Ludum platform — architecture and parallel-work contract (v1)

**Status:** ARCHITECTURE PASS, accepted by the owner on 2026-10-09, branch
`phase3/consolidated-final-preplaytest-integration`.
- This document is the frozen interface contract for the three implementation lanes. Changing a section marked FROZEN requires
  a coordinator amendment to this file.
- The accepted revision adds two corrections:
  - §2.1 makes cross-origin credentialed CORS exact, and §10.3 adds its negative tests.
  - §2.4 sets the Ludum script and CSP policy, reconciled with the shared `netadao.org` radio and GitHub Pages' header
    limits.
- Nothing here has been deployed.

Everything below was inspected read-only on 2026-10-09: the repository, the sibling `ludum` repository, live DNS and HTTP, and
live uni-7 smart queries. "Verified live" means a chain or HTTP read made on that date.

---

## 1. What exists today

### 1.1 Ludum site (verified live)
- `https://ludum.netadao.org` is **already deployed**: static HTML, CSS and JS from the public repo `cosmonought/ludum`
  (local `..\ludum`, branch `main`, root `/`), served by **GitHub Pages** (`Server: GitHub.com`, Let's Encrypt certificate).
- DNS for `netadao.org` is authoritative at **Squarespace** (`nsc1-4.squarespacedns.com`).
  `ludum` CNAMEs to `cosmonought.github.io`. The DNS records are owner-managed; no Terraform touches them.
- The site has no build step: `design-system/css/ludum.css` and `design-system/js/ludum.js`, plus generated pages.
- House rule: "PLAY always leaves for play.netadao.org".
- Cost: $0.

### 1.2 Play (verified live)
- `play.netadao.org` CNAMEs to CloudFront `EX397QAOSJMW7`.
  - Default behaviour goes to `site-origin.netadao.org`, which is Vercel project `1830-juno-edition`.
  - `/gs*` goes to `gs-origin-host.netadao.org`, the EC2 host `i-01fe56536bf591382`, then Caddy, then `:8917`.
  - Caching is disabled on `/gs*`. All methods are allowed. The Origin and WebSocket headers are forwarded.
- The ACM certificate covers `play.netadao.org` only.
- The deployed product is **Project 18XX** (`APP_NAME`). The Ludum site lists both Project 18XX and 20 Cosmos as "In
  development". Section 6.1 treats the product key as data.

### 1.3 Identity (source: `server/src/identity/**`)
- An account is a **Profile** (`pf_`), which owns one **Principal** (`pr_`, never on the wire).
  - Sign-in uses a username and password (scrypt).
  - The **Authorization Wallet** is an ADR-036 `18COSMOS/PROFILE-AUTHORIZATION/v1` text bound to `Site:` = the request
    Origin. It is an account authority, never a login.
- Session cookie:
  `__Host-gs_session=v1.<se>.<secret>; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=15552000`.
  - The cookie is host-only on `play.netadao.org`.
  - Lifetime: 30 days idle and 180 days absolute. The session rotates after 7 days.
  - Revocation is by family (logout), other-sessions, or password change. Recovery revokes all of these.
  - Step-up re-authentication: a 5-minute grant via `/gs/api/profile/reauth`.
- Every `/gs/api/*` route is POST only, with exact-match `Origin` ∈ `GS_ALLOWED_ORIGINS`, JSON of at most 4 KiB, and
  **no CORS**. Routes are registered in `server/src/gameServer.ts` in the order money, trust, conduct, identity.
- Website moderators are `GS_CONDUCT_REVIEWERS` (conduct review). They are **not** DAO governors and are never treated as
  governors.

### 1.4 Ludum DAO on uni-7 (verified live)

| Role | Address | Code / version |
|---|---|---|
| DAO core (admin = itself) | `juno1fccq3dcjjn35fgt8u8jfz5kvcajfk604lhl85w25k6pr32q9r7psk6wrpu` | 28 · dao-dao-core 2.7.0 |
| Proposal module (single) | `juno1shhuc4w9ht7kfzjamhz5xvatywtyzfhz6npcm8lvp8p0jlnrkk0suqcpe8` | 35 · dao-proposal-single 2.7.0 |
| Pre-propose (single) | `juno1huu2ysuct2e9xnmxc28xdwfeflytw2samzp95a2devjqs0qfj6fqpsmvcf` | 33 · dao-pre-propose-single 2.7.0 |
| Proposal module (multiple) | `juno10va8m9zqllgypj4eyyph0rszushr43l9pg2lgn4wau7adguzau4s50a6su` | 34 · dao-proposal-multiple 2.7.0 |
| Pre-propose (multiple) | `juno1glupnpaf5pzh8ym6e64vuph937jqqwjlg0pzfv7lnwthg6pekahsz2783p` | 32 |
| Voting | `juno12cjzsve63f6v2rt6uekyp0ytqynsw25023vjw5ry45vw87vgyr2q9h8ym3` | 38 · dao-voting-cw4 2.7.0 |
| cw4 group (admin = core) | `juno13dvggejlcz6nxn8kzzhr2m0e94r7adepr9crclum82uv7eyegftq2yz5up` | 2 |
| Escrow 2.1 | `juno19vd5hphghprl2m8agchctyav8pmeh6p4x3vud6cfhd2y6ulwtf0s0jrk7x` | 125 · eighteen-cosmos-escrow 2.1.0 |

**Single-choice module configuration:**
- `threshold_quorum`: majority, quorum 0.2.
- `max_voting_period`: 604800 s (7 days).
- `only_members_execute`: true. `allow_revoting`: false. `close_proposal_on_execution_failure`: true. No veto.

**Pre-propose:** no deposit; the submission policy is `specific { dao_members: true }`.

**Members:** a single member, `juno1kkerfymlqzjd45xlvvle6yyjh849m7xvpf9jaq`, weight 1000 of 1000.

**Current state:** there are 0 proposals, and the escrow has 0 games (`next_chain_game_id` 1).

**Escrow configuration:** resolver = treasury = DAO core. `subsidy_bps` 250, `bond_bps` 5000, `bond_floor` 1000000,
`resolver_timeout_secs` 2592000.

**Read paths:**
- REST `https://juno.api.t.stavr.tech` answered. Use `/cosmos/tx/v1beta1/txs?query=`; the `events=` form does not work.
- The project RPC proxy `https://d3d68n2c5eingb.cloudfront.net` (`tx_search` on `wasm._contract_address`) works.
- Polkachu and `api.uni.junonetwork.io` did not answer.
- There is **no indexer dependency**. DAO DAO has no Juno-testnet indexer.

### 1.5 Player data (source)
- There is **no account → games index** anywhere (identity, game table, or chain). "My tables" scans the in-memory
  `recordIndex` with `seatOf(record, principalId)`, capped at 50, and excludes closed games.
- Outcomes are only recorded durably for money games, in `FinancialGameRecord.intent` (`terminal_reason`, `totals` in
  in-game dollars, `log_hash`). For non-money games they come only from replaying the log.
- Server-side, per-seat JUNOX payouts are **not** stored. They exist only on chain (`Game.outcome.amounts`).
  `transitions[]` is capped at 64.
- The escrow cannot be queried by wallet: `games{start_after,limit≤30}` pages through every game.
- **Conflation hazard:** the board's legacy `total_juno_pool` is not the escrow and must never feed any money figure.

---

## 2. Component architecture

```
 ludum.netadao.org  (GitHub Pages, static, $0)                     play.netadao.org (CloudFront EX397QAOSJMW7)
 ┌───────────────────────────────────────────────┐                ┌──────────────────────────────────────────┐
 │ shared: platform/js/session.js (Lane A)       │  fetch POST    │ /gs/api/ludum/v1/*  LudumIngress (Lane A) │
 │   sign-in link → play, whoami, api client     │ ─credentials──▶│   exact Origin ∈ GS_LUDUM_ORIGINS, CORS    │
 │ /me/        profile + history     (Lane C)    │  :'include'    │   for this prefix ONLY, never Set-Cookie   │
 │ /disputes/  register + case page  (Lane B)    │                │   → session.authenticate (no rotation)     │
 │ /governance/ proposals/vote/exec  (Lane B)    │                │   → handler registry                       │
 │   vendored cosmjs + Keplr ─────────────────┐  │                │      ├ session   (Lane A)                  │
 └────────────────────────────────────────────┼──┘                │      ├ games/game (Lane C, history/)       │
                                              │ smart queries,    │      └ case       (Lane B, disputes/)      │
                                              │ signed txs        │   LudumPorts (Lane A wires in gameServer)  │
                                              ▼                   └──────────────────────────────────────────┘
                     uni-7: DAO core / proposal-single / pre-propose / cw4 / escrow 2.1
```

### 2.1 Decision: SSO by credentialed CORS on a dedicated read-only prefix
`ludum.netadao.org` and `play.netadao.org` are **same-site** (registrable domain `netadao.org`). So a `fetch(...,
{credentials:'include'})` from Ludum to `https://play.netadao.org/gs/api/ludum/v1/*` sends the existing host-only
`__Host-gs_session` cookie, because `SameSite=Strict` allows same-site requests. This is unaffected by third-party-cookie
blocking or by Firefox partitioning, both of which key on site.

The pages are same-site but **cross-origin**, so the browser applies CORS. Both sides must be exact.

**Client (Ludum).** Every authenticated call is:

```js
fetch("https://play.netadao.org/gs/api/ludum/v1/<route>", {
  method: "POST",
  mode: "cors",
  credentials: "include",
  cache: "no-store",
  redirect: "error",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
```

The `application/json` content type makes every call non-simple, so the browser always sends a preflight first.

**Server preflight.** `OPTIONS /gs/api/ludum/v1/<known route>`:
- If `Origin` is in the Ludum ∪ Play allow-list, answer `204` with:
  - `Access-Control-Allow-Origin: <that exact origin>`
  - `Access-Control-Allow-Credentials: true`
  - `Access-Control-Allow-Methods: POST`
  - `Access-Control-Allow-Headers: Content-Type`
  - `Access-Control-Max-Age: 600`
  - `Vary: Origin`
  - `Cache-Control: no-store`
- Otherwise answer `403` with **no** `Access-Control-*` header.
- The preflight is answered statically. Edge policy `gs` forwards only `Origin` and the WebSocket headers, **not**
  `Access-Control-Request-*` or `Sec-Fetch-*` (`infra/aws/modules/app/edge.tf:35-39`). So the server must not depend on those
  headers, and no infrastructure change is needed.
- A preflight carries no cookie. It never authenticates and never touches the session store.

**Server actual request.** `POST`:
- Requires exactly one `Origin` header, in the allow-list, compared byte for byte. These are refused: `null`, a missing
  Origin, `http:`, a different port, a trailing slash, a suffix look-alike, and duplicate headers.
- Requires `Content-Type: application/json`, so `text/plain` or form "simple" requests are rejected before any work.
- Every response to an allowed origin carries the exact `Access-Control-Allow-Origin`,
  `Access-Control-Allow-Credentials: true` and `Vary: Origin`, including 4xx and 5xx errors, so Ludum can read the error
  JSON.
- The response never uses `*`, never reflects an unlisted origin, never sends `Set-Cookie`, and does not add
  `Access-Control-Expose-Headers`.
- Every route outside `/gs/api/ludum/v1/` keeps its current behaviour: no CORS headers, and a Ludum origin gets `403` there.

**Session semantics through the ingress:**
- Valid live sessions only.
- A rotated predecessor (usable for 24 h **only to bootstrap**), a revoked, idle-expired or absolute-expired session, a
  provisional session, an unprofiled session, or a session with no cookie: each resolves to `principalId: null`. The call
  never rotates and never mints a session.
- Updating `last_seen` follows the existing at-most-every-15-minutes rule, without `Set-Cookie`.

**What this preserves:**
- There is no new cookie, no `Domain=` cookie and no token in JS storage.
- It is the same session, so logout, sign-out-others, password change and recovery revoke Ludum access instantly.
- Rotation stays on Play.
- Step-up is not needed, because v1 Ludum routes are read-only.
- Sign-in and sign-out happen on Play. Ludum links to `https://play.netadao.org/?ludum=signin&return=<path>`, and Play
  returns to `https://ludum.netadao.org<path>` only when the path matches `^/[a-z0-9/_-]{0,128}$`. The host is hard-coded,
  so this is not an open redirect.
- The Authorization Wallet's `Site:` binding is untouched. Ludum never mints wallet texts.

**What it costs:** the CORS grant is per **origin**, not per page. Any script running on any `ludum.netadao.org` page can
read the signed-in account's Ludum v1 data. Section 2.4 governs which scripts may run there.

`GS_LUDUM_ORIGINS` is **not** added to `GS_ALLOWED_ORIGINS`. The money, identity, conduct and trust routes stay closed to
Ludum.

**Rejected alternatives:**
- A shared `Domain=netadao.org` cookie. Prohibited.
- A one-time-code handoff to a second session. GitHub Pages has no backend; it would mean a bearer token in JS and a second
  revocation domain.
- Moving Ludum behind the Play distribution. That needs a new alias and certificate plus host routing on Play's edge, and the
  budget forbids a new distribution.

### 2.2 Decision: governance is chain-direct from the browser
- Ludum reads the DAO and the escrow by smart query and signs with Keplr through vendored, pinned cosmjs. Use the same
  version family as `frontend/package.json`.
- The server is never in the governance trust path.
- Governor status is **only** chain membership: cw4 `member{addr}` and pre-propose `can_propose`, for the wallet connected in
  Keplr. The account's Authorization Wallet is shown alongside as a hint ("this account's Authorization Wallet is / is not a
  Ludum DAO member"). It is never used to grant UI powers. Conduct reviewers get nothing in governance.

### 2.3 Decision: player history is a server projection, labelled by provenance
- The server owns the account → seat join, because principals are private. It computes JUNOX figures from a **quorum chain
  read** (existing `junoRest.smartQuorum`) where one is available.
- Every figure carries a provenance (section 4). The Ludum page may re-verify chain facts directly; v1 does not have to.

### 2.4 Decision: script policy and CSP on GitHub Pages
**Facts, verified 2026-10-09:**
- GitHub Pages lets us set **no** response headers. `ludum.netadao.org` sends no CSP, `X-Frame-Options` or HSTS header.
- Every Ludum page loads three scripts:
  - `/design-system/js/ludum.js`;
  - an **inline** `<script>Ludum.enhance();</script>`;
  - `https://netadao.org/radio/radio.js`.
- `radio.js` is the owner's shared radio for netadao.org, academy, fork, ludum and play. It is served by GitHub Pages from the
  owner's `cosmonought/website` repo, so it is first-party code on a same-site origin, not a third party. It does the following:
  - injects a `<style>` element and inline-styled markup;
  - loads `https://netadao.org/radio/neta-mark-night.png`;
  - plays `https://s3.radio.co/s39c195d74/listen`, which answers 200 directly with no redirect;
  - when the radio is on, opens family pages (`(www|academy|fork|ludum|play).netadao.org`) in a full-window `<iframe>`
    "shell".

**Script rule for the whole Ludum origin.** Only these may run on any `ludum.netadao.org` page:
- the `ludum` repo's own files;
- the exact URL `https://netadao.org/radio/radio.js`, which is owner first-party.

Anything else is refused: no analytics, no CDN libraries, no embeds that run script. cosmjs is vendored and pinned in the
`ludum` repo.

Lane A ships `platform/tools/check-scripts.mjs`, which scans every `*.html` in the `ludum` repo and fails on any
`<script src>` outside that allow-list. The coordinator runs it at integration.

Self-hosting a copy of `radio.js` is rejected. It would fork the one shared radio and break its update path. SRI is also
rejected, because the radio changes with the website.

**Enforceable CSP via `<meta>`.** This is required on every page that calls the Play API: `/me/`, `/disputes/`,
`/governance/` and their sub-pages. It must be the first element in `<head>`, before any script.

```
default-src 'self';
script-src 'self' https://netadao.org/radio/radio.js;
style-src 'self' 'unsafe-inline';
img-src 'self' data: https://netadao.org;
font-src 'self';
media-src https://s3.radio.co;
connect-src 'self' https://play.netadao.org https://juno.api.t.stavr.tech https://d3d68n2c5eingb.cloudfront.net;
frame-src https://netadao.org https://www.netadao.org https://academy.netadao.org https://fork.netadao.org https://ludum.netadao.org https://play.netadao.org;
object-src 'none';
base-uri 'none';
form-action 'self';
upgrade-insecure-requests
```

The reason for each choice:
- **`script-src` has no `'unsafe-inline'`.** The API pages therefore must not use inline scripts: they call
  `Ludum.enhance()` from a self-hosted `platform/js/page-init.js`.
- **`style-src` allows `'unsafe-inline'`.** The radio needs it, and style injection carries low risk.
- **`connect-src` names only:**
  - the Play API;
  - the chain read endpoints from section 1.4, for Lane B's pages; Lane C's `/me/` may omit them.

**What a meta CSP cannot do:**
- It cannot enforce `frame-ancestors`, `report-uri`, `report-to` or `sandbox`. Browsers ignore these in `<meta>`, so they are
  left out rather than written and silently ignored.
- So framing is controlled in script. Lane B's action pages (propose, vote, execute, close) enable those buttons only when
  `window.top === window`, or when `location.ancestorOrigins` confirms that every ancestor is a family origin (the radio
  shell). Otherwise they show "Open in its own tab".
- Read-only pages may be framed. A framing parent cannot read cross-origin content, and every chain action is confirmed again
  in Keplr's own window.

**Keplr.** Its injected provider comes from the extension origin, which browsers exempt from page CSP. Lane B verifies this
by hand in Chrome and Firefox, under the policy above, and reports the result.

**Existing marketing pages are unchanged:** home, projects, about and 404 keep their inline `Ludum.enhance()` and the radio.
They never call the API. The separate design work owns them.

**No hosting change.** The headers we can't send (HSTS, `X-Frame-Options`, `frame-ancestors`) are accepted limits of
GitHub Pages, and are mitigated as described above.

---

## 3. Ownership boundaries (FROZEN)

Each path has exactly one owning lane. A lane may read anything, but writes only its own paths.

| Path | Owner |
|---|---|
| `server/src/ludum/contract.ts`, `ports.ts`, `registry.ts`, `registry.test.ts` and the two stub `index.ts` files (step 0) | **Coordinator**, committed on `ludum/baseline`; frozen after that |
| `server/src/ludum/ingress.ts`, `session.ts`, `wiring.ts`, other `*.test.ts` in the `server/src/ludum/` root | **A** |
| `server/src/gameServer.ts` (one hunk: build `LudumPorts` and dispatch `/gs/api/ludum/` **before** the money handler) | **A** |
| `server/src/identity/mode.ts` (or the runtime-config reader) for `GS_LUDUM_ORIGINS` / `ludum_origins` | **A** |
| `frontend/src/**`: Play sign-in "return to Ludum" handling | **A** |
| `server/package.json`: test-script entries for `server/src/ludum/*.test.ts` in the root | **A** |
| In the `ludum` repo: `platform/js/session.js`, `platform/js/page-init.js`, `platform/tools/**`, `platform/README.md` | **A** |
| `server/src/ludum/history/**` (handlers `games` and `game`, money arithmetic, tests; replaces the stub `history/index.ts`) | **C** |
| In the `ludum` repo: `me/**`, `platform/js/history.js`, `platform/tests/history*` | **C** |
| `server/src/ludum/disputes/**` (handler `case` and its tests; replaces the stub `disputes/index.ts`) | **B2** |
| In the `ludum` repo: `disputes/**`, `governance/**`, `platform/js/gov*.js`, `platform/vendor/**`, `platform/tests/gov*` | **B1** (B2 adds only the `case` fetch, inside B1's files, after B1 merges) |
| `docs/ludum/**`, `ROADMAP_3_2_REMAINING_WORK.md`, `docs/phase3/**`, `PROJECT_CANONICAL_CONTEXT.md` | **Coordinator**. Lanes send their notes in the report. |
| **Every pre-existing file in the `ludum` repo**: `index.html`, `projects/**`, `about/**`, `404.html`, `design-system/**`, `assets/**`, `README.md`, `CNAME` | **Nobody in these lanes.** These files belong to the separate Claude Design / Cowork work. Lanes **read** `design-system/css/ludum.css` and `design-system/js/ludum.js`, never edit them. Adding nav links from the existing pages to `/me/`, `/disputes/` and `/governance/` is a later hand-off to that work. |

- Lanes B and C add their test files to `server/package.json` **via the coordinator at integration**. They list them in the
  report; they do not edit `package.json`.
- The new Ludum pages (`me/`, `disputes/`, `governance/`) use the design system's CSS classes and components as they are. If
  a page needs a component that doesn't exist, the lane builds it inside its own page or `platform/` files and reports it as a
  candidate for the design system.
- Nobody edits `infra/**`, `contracts/**`, `server/src/identity/**` (beyond A's `mode.ts`), `server/src/escrow/**` or
  `server/src/rooms/**`. If a lane needs a new read accessor there, it states it in its report and the coordinator assigns it.
  Exception: Lane A may add read-only accessors that `ports.ts` needs.

---

## 4. Shared data model (FROZEN)

**`Provenance`:**
- `"chain-confirmed"`: read from chain via a quorum read, with `height`.
- `"chain-observed"`: a single-endpoint or cached chain read, with `observedAt`.
- `"server-recorded"`: the server's own durable record, not a chain fact.
- `"pending"`: submitted or expected, not yet seen on chain.
- `"unavailable"`: not knowable now. Always paired with a `reason`.

**`Fact<T>`** is `{ value: T | null, provenance, observedAt?: ISO, height?: string, reason?: string }`. `value` is null iff
the provenance is `unavailable`.

**`Junox`** is `{ amount: string /* integer base units, /^-?\d+$/ */, denom: "ujunox" }`.
- Display uses 6 decimals and the symbol `JUNOX`, formatted on the client.
- Never a JS number.
- Negative values are allowed only in `net`.

**`InGameMoney`** is `{ dollars: number /* whole in-game $ */ }`. It is a distinct type and is never summed, compared or
co-displayed with `Junox` in one total.

**Game reference:**
- `gameId`: the same `g_…` id the money API already exposes.
- `joinCode` is a display alias.
- `chainGameId` is a string of digits, or null.

**Seat reference:** `chainSeatIndex` (number, or null for no-money games) and `displayName`. A principal id **never**
appears on the wire.

**Status vocabulary:**
- `table`: `waiting | active | completed | cancelled | expired | archived` (from the GameRecord, after `effectiveStatus`).
- `escrow`: the chain `Game.state` lowercased: `funding | funded | in_progress | settleable | disputed | settled |
  cancelled | annulled`.

**Per-seat money ledger.** `entries[]`, each `{ kind, amount: Junox, fact provenance }`. The kinds are:

| Kind | Direction and meaning |
|---|---|
| `ante_gross` | out (debit): what the seat deposited |
| `subsidy` | informational: the part of `ante_gross` taken at deposit, `= Seat.subsidy_paid` |
| `bond_posted` | out (debit), challenger only |
| `bond_returned` | in (credit) |
| `bond_forfeited` | informational |
| `payout` | in (credit): `outcome.amounts[chainSeatIndex]` |
| `refund` | in (credit): cancel, withdraw or annul refund, per the contract's actual route |

- **Sign convention (codified at integration, `server/src/ludum/integration.test.ts`):** every entry `amount` is a
  **non-negative magnitude**; the entry **kind alone** gives the direction. `net = Σ credits − Σ debits`, and `net` is the
  only value that may be negative.
- `subsidy` and `bond_forfeited` are informational and are not added again, because they are already inside `ante_gross` /
  `bond_posted`.
- Network gas is **excluded**, and is labelled "network fees not included".
- If any entry needed for `net` is not `chain-*`, then `net.provenance` is the weakest provenance among its inputs.
- Lane C must derive each route's entries from `contracts/escrow/src/payout.rs` and `execute/*.rs`, not from these notes,
  and pin them with tests against `fakeJunoChain`.

---

## 5. API contract v1 (FROZEN)

**Base:** `https://play.netadao.org/gs/api/ludum/v1/`.

**Requests:**
- Every route is `POST`, `Content-Type: application/json`, body of at most 1 KiB, closed schema. Unknown keys get a 400.
- The `Origin` must be in `GS_LUDUM_ORIGINS` ∪ `GS_ALLOWED_ORIGINS`.
- `OPTIONS` preflight is answered for this prefix only, exactly as §2.1 specifies.
- Any other method gets `405`. For the full list of what a request must carry and what a response must contain, §2.1 is
  normative.

**Responses:**
- `Cache-Control: no-store`, `Vary: Origin`.
- **Never** `Set-Cookie`. A request without a valid profiled session gets an answer as signed-out. It never mints a
  provisional session.
- Rate-limited through the existing `limiter.ts`.

**Error shape:** `{ error: "bad-request" | "signed-out" | "not-found" | "rate-limited" | "unavailable", detail?: string }`,
with statuses 400, 401, 404, 429 and 503.

```ts
// server/src/ludum/contract.ts — types only
export type Provenance = "chain-confirmed" | "chain-observed" | "server-recorded" | "pending" | "unavailable";
export interface Fact<T> { value: T | null; provenance: Provenance; observedAt?: string; height?: string; reason?: string }
export interface Junox { amount: string; denom: "ujunox" }
export interface InGameMoney { dollars: number }
export interface Product { key: string; name: string }            // v1: { key: "project-18xx", name: "Project 18XX" } from server config

// A — POST session {}  (public; 200 either way)
export type SessionResponse =
  | { signedIn: false; signInUrl: string }                            // https://play.netadao.org/?ludum=signin&return=…
  | { signedIn: true; account: { name: string; username: string; memberSince: string /* YYYY-MM */;
        authorizationWallet: { address: string; since: string } | null }; manageUrl: string };

// C — POST games { cursor?: string; limit?: number /* 1..50, default 20 */ }  (profiled; 401 otherwise)
export interface GameSummary {
  gameId: string; joinCode: string | null; product: Product; variant: string | null;
  table: Fact<"waiting" | "active" | "completed" | "cancelled" | "expired" | "archived">;
  createdAt: string; startedAt: string | null; endedAt: string | null;
  seat: { displayName: string; chainSeatIndex: number | null };
  playerCount: number;
  money: null | {                                                   // null = no-money table
    chainGameId: string | null; contract: string; chainId: string;
    escrow: Fact<string>;                                           // chain Game.state, lowercased
    anteGross: Junox;                                               // terms (server-recorded until chain-confirmed)
    net: Fact<Junox>;
  };
  inGame: { rank: Fact<number>; finalNetWorth: Fact<InGameMoney> };
  disputed: Fact<boolean>;
}
export interface GamesResponse { games: GameSummary[]; nextCursor: string | null; asOf: string }

// C — POST game { gameId: string }  (profiled; 404 unless this account holds a seat)
export interface GameDetail extends GameSummary {
  seats: Array<{ displayName: string; chainSeatIndex: number | null; you: boolean;
                 finalNetWorth: Fact<InGameMoney>; rank: Fact<number> }>;
  terminal: Fact<{ reason: "BankBroken" | "Bankruptcy"; logLen: number; logHash: string }>;
  ledger: null | { entries: Array<{ kind: "ante_gross" | "subsidy" | "bond_posted" | "bond_returned" | "bond_forfeited" | "payout" | "refund";
                                    amount: Junox; fact: Fact<true> }>;
                   net: Fact<Junox>; networkFeesIncluded: false };
  dispute: null | Fact<{ challengerIsYou: boolean; bond: Junox; evidenceHash: string; disputedAt: string;
                         resolverTimeoutAt: string; resolution: "uphold" | "annul" | "replace" | null; resolvedAt: string | null }>;
  caseUrl: string | null;                                           // https://ludum.netadao.org/disputes/case/?id=<chainGameId>
}

// B — POST case { chainGameId: string }  (PUBLIC, no session needed; contains no account data, no display names)
export interface CaseRecord {
  chainGameId: string; contract: string; chainId: string;
  escrow: Fact<string>;
  seats: Array<{ chainSeatIndex: number; wallet: string; isChallenger: boolean }>;      // wallets are already public on chain
  dispute: Fact<{ challenger: string; bond: Junox; evidenceHash: string; disputedAt: string; resolverTimeoutAt: string }>;
  chainSettlement: Fact<{ seq: string; logHash: string; appraisalStateHash: string; weights: string[] }>;
  serverTerminal: Fact<{ logLen: number; logHash: string; appraisalStateHash: string; reason: string;
                         totalsBySeat: Array<{ chainSeatIndex: number; dollars: number }> }>;
  evidenceMatches: Fact<"server-log" | "server-board" | "neither">;  // challenger evidence_hash vs server's own log/board hashes
}
```

**Cursor.** It is opaque: base64url of `{createdAt, gameId}`. Order is newest first. The list **includes** completed,
cancelled, expired and archived games. An archived game whose record has moved off-line is returned with
`table.provenance = "unavailable"`.

**Ludum JS surface.** `platform/js/session.js` (Lane A) exposes a global `LudumSession`:
- `whoami()`, which returns a `Promise<SessionResponse>`.
- `api(path, body)`, which returns `Promise<json>`. It sends the exact §2.1 client `fetch` (`mode:'cors'`,
  `credentials:'include'`), maps errors, and redirects to `signInUrl` on 401 if asked.
- `signInUrl(returnPath)`.
- `PLAY_ORIGIN`.

Lanes B and C call only `LudumSession.api`.

### 5.1 Amendment v1.1 (coordinator, 2026-10-09; owner request "PROCEED WITH IMPLEMENTATION AND DESIGN INTEGRATION")

Additive only: no v1 field changes meaning, and every new field is optional on the wire. The types are in
`server/src/ludum/contract.ts` (the v1.1 block). Error vocabulary gains `conflict` (409, with `detail`) and
`reauth-required` (403, with `confirmUrl`).

| Route | Access | Body | Answer |
|---|---|---|---|
| `session` | public | `{}` | v1, plus `roles: {reviewer}` when signed in (draws the Moderation tab) |
| `account` | profiled | `{}` | `{displayName: {name, state, changedAt}, tablemates: Fact<trust facts>, roles}` |
| `display-name` | profiled | `{name}` | the ONE change: 200 `{displayName}`; 400 `bad-name`; 409 `taken` / `unchanged` / `already-changed` / `locked-playing` / `locked-seated` |
| `moderation-queue` | reviewer | `{}` | `{cases, unreadable}` (Play's reviewer views) |
| `moderation-case` | reviewer | `{caseId}` | `{case}` |
| `moderation-decide` | reviewer | `{caseId, revision, status, note?}` (8 KiB) | `{case}`; 403 `reauth-required` without a live "Confirm it's you" |
| `game` | profiled | v1 | v1, plus `transactions` |
| `case` | public | v1 | v1, plus `seats[].displayName` and `transactions` |

- **Display names** are unique by an NFKC, case- and space-folded key, enforced by the single identity writer; names two
  legacy profiles already shared stay. A profile has ONE change, before its first game: refused while it holds a seat
  at a waiting table, and once any table it sits at has started. It is written under a `profile-name` compare-and-swap
  (memory store and DynamoDB alike) and recorded in the optional schema-3 field `name_changed_at`. Account creation
  answers 409 `display-name-taken`. The change is not a security event, so a security-journal replay does not carry
  it: an identity restore from a backup taken before a change shows the earlier name.
- **"reviewer" access**: anyone who is not one of the conduct reviewers bound at Play's startup -- signed out included
  -- gets 404 `not-found`, as for a route that does not exist. The service, the party exclusion and the transitions are
  Play's own (`conduct/conductService.ts`); a decision needs the session's live sensitive grant, given on Play
  (`https://play.netadao.org/?ludum=confirm&return=/moderation/`). Play's `/gs/api/conduct/*`, `/gs/api/trust/*` and
  account routes stay closed to Ludum's origin: no CORS was relaxed.
- **Seat display names** on the public case record are the names the table showed every seat (frozen at the deal),
  mapped through the server's frozen roster only when it names exactly the chain's seat wallets; otherwise null.
- **Transactions** are those THIS server relayed (its chain intents): `included` (chain-observed by the relayer, with the
  height) or `broadcast` (pending). Wallet-signed transactions (create, join, challenge, DAO proposals) never pass the
  server; `walletSigned: "not-server-recorded"` says so.
- **Play links** (each checks the path `^/[a-z0-9/_-]{0,128}$`, the host is a build constant): `?ludum=signin`,
  `?ludum=confirm` ("Confirm it's you" on Play, then back) and `?ludum=signout` (Play asks once, signs this browser
  out, then back; a link alone never signs anyone out).

### 5.2 Escrow policy (owner, 2026-10-09)

Escrow 2.1's resolver-timeout behaviour is final. The "timeout-exit fix" is removed from the backlog: no change,
replacement or redeployment of the escrow contract is planned for it. The pages show the exit exactly as the deployed
contract defines it.

---

## 6. Governance contract for appeals (verified source + live config; FROZEN)

**Resolve message.** Escrow `ExecuteMsg::Resolve`:
`{"resolve":{"chain_game_id":<u64 number>,"outcome":{"uphold":{}}|{"annul":{}}|{"replace":{"payload":<SettlementPayloadV1 reason 5>}}}}`.
- It carries no funds.
- The game state must be `Disputed`.
- The sender must equal `game.resolver`, which is frozen at Start (the DAO core).
- It fails with `ResolverIsSeated` if the resolver holds a seat.
- A paused contract does not block it.
- `Replace` is refused for remedy foreclosure, and must be beyond the trusted checkpoint.
- v1.1: Ludum builds the Replace payload in the browser (`platform/js/gov.js` `replacePayload`): version 1, the game's
  domain, kind 1, reason 5, `seq = 2·log_len + 1`, `appraisal_log_len == log_len`, `state_schema_version` 1, one u128
  weight per seat with a positive sum, beyond the trusted checkpoint. The case page prefills it from the server's
  terminal record only once that record agrees with the chain; the proposer may correct the weights. It is authorised by
  the DAO's executing transaction, never signed by the server.

**Race with liveness settle.** After `disputed_at + 2592000 s`, any seated wallet may `liveness_settle`. After that the game
is no longer disputed, and a later DAO execute becomes `execution_failed` (the proposal closes).

**Submitting.** A member signs `MsgExecuteContract` to the **pre-propose**
`juno1huu2ysuct2e9xnmxc28xdwfeflytw2samzp95a2devjqs0qfj6fqpsmvcf`, with `funds: []`:
`{"propose":{"msg":{"propose":{"title":"Appeal: escrow game #<id> — <outcome>","description":"<case summary + case URL>","msgs":[{"wasm":{"execute":{"contract_addr":"<escrow>","msg":"<base64 Resolve>","funds":[]}}}],"vote":null}}}}`.
- Sending this direct to the proposal module fails.
- `vote: {"vote":"yes"}` is allowed. With today's single member, the proposal then passes in the same transaction. It is shown
  as an explicit opt-in checkbox.

**Then, on the proposal module `juno1shhuc4…`:**
1. `{"vote":{"proposal_id":N,"vote":"yes"|"no"|"abstain","rationale":…}}`. Members only, no revoting.
2. `{"execute":{"proposal_id":N}}`. Members only, once the proposal passes.
3. `{"close":{"proposal_id":N}}`. Anyone, once it is rejected.

**Linking a proposal to a game:** read `list_proposals` / `reverse_proposals` and decode each proposal's `msgs`. A proposal
belongs to game G iff it has exactly one `wasm.execute` to the pinned escrow whose decoded body is `resolve` with
`chain_game_id == G`. Anything else is shown as "other proposal" and never linked.

**Dispute register:** page escrow `games` and keep `state == disputed`. Also list resolved disputes (`dispute.resolution !=
null`).

**Deadline guard.** The UI refuses to prefill a proposal when `resolverTimeoutAt - now < max_voting_period + 24 h`. Today
that is 8 days. It shows why, and offers nothing that would race `liveness_settle`.

**Pinning.** The UI reads module addresses from the DAO core (`proposal_modules`) at load, and refuses to run if they
differ from the pinned table in section 1.4 (pin mismatch: stop, do not guess).

**Governors:** cw4 `member{addr}` > 0 and pre-propose `can_propose{address}` true, both for the Keplr-connected address.

---

## 7. Phase-3-critical vs Ludum roadmap

**Phase-3-critical** (the owner-decided P3 item "Create Appeal Proposal workflow" in `ROADMAP_3_2_REMAINING_WORK.md`):
- **B1** (chain-only, `ludum` repo only, **no server change, no Play deploy**):
  - The dispute register.
  - The case page from chain facts.
  - The prefilled propose flow, plus vote, execute and close.
  - The deadline guard and the pinning check.
- It is unblocked today, and does not depend on Lanes A or C.

**Ludum platform roadmap** (not Phase-3 gating):
- **A** (SSO ingress and session).
- **C** (history and finances).
- **B2**: the server `case` enrichment, which needs A's ingress.
- Later:
  - a durable account → games index;
  - multiple products;
  - ~~Ludum-side sign-out~~ (v1.1: on Play, through `?ludum=signout`);
  - mainnet DAO pins, once a mainnet Ludum DAO is decided. None is decided today.

---

## 8. Deployment and cost implications

**Recurring cost: +$0/month.**
- GitHub Pages: $0.
- The new routes run on the existing host.
- DynamoDB reads are negligible.
- Chain reads go from the browser to the public REST endpoint, or from the server via its existing `junoRest`.
- No new CloudFront distribution, certificate, DNS record, table, GSI or KMS key.
- The ceiling stays at $30. The budget projects about $19.61 steady state, or about $24.20 before the Savings Plan.

**Server deployment.** It ships as a new image through the existing single-host release procedure, like the 2026-10-09
cutover.
- **Constraint:** `GS_LUDUM_ORIGINS` must **not** be delivered by editing
  `infra/aws/modules/single-host/templates/server.env.tftpl`. That file is rendered into `user_data` with
  `user_data_replace_on_change = true`, so the instance would be **replaced**.
- Lane A must source it from the existing runtime config document (`GS_AWS_CONFIG_PARAMETER`) or an equivalent that needs
  no instance replacement. If neither exists, Lane A stops and reports. **This is not a coordinator decision to change
  infra.**

**Edge.** No change: `/gs*` already forwards `Origin`, allows all methods (OPTIONS included) and has caching disabled.
Verify after deploy with an `OPTIONS` request from the Ludum origin.

**Ludum deployment.** A push to `cosmonought/ludum` `main` publishes. It is a separate, owner-scoped publish step for each
lane.

**Play frontend.** The return-to-Ludum change ships via the existing Vercel procedure.

---

## 9. Parallel execution order

| Step | Lane A | Lane B | Lane C |
|---|---|---|---|
| 0 | **DONE by the coordinator on `ludum/baseline`:** `contract.ts` (section 5), `ports.ts` (section 9), `registry.ts` plus stubs that answer 503 `unavailable` | — | — |
| 1 | Ingress + CORS + session handler + Play return-to + `platform/js/session.js` + `check-scripts.mjs` | **B1 (P3-critical), starts immediately**: chain-only register, case, propose/vote/execute in `ludum` | History handlers against `LudumPorts` (fakes in tests); money arithmetic from contract source |
| 2 | Wire real `LudumPorts` in `gameServer.ts` | B2 `case` handler | `/me/` page against `LudumSession.api` (mock until A lands) |
| 3 | Integration (coordinator) | | |

Lanes C and B2 start as soon as step 0 is committed. They code against `contract.ts` and the `LudumPorts` interface, which
is frozen at step 0:

```ts
export interface LudumPorts {
  records(): Iterable<GameRecord>;                                   // read-only view of roomHost recordIndex
  seatOf(record: GameRecord, principalId: string): Seat | null;
  financial(gameId: string): Promise<FinancialGameRecord | null>;
  financialByChainGameId(chainGameId: string): Promise<FinancialGameRecord | null>;
  terminalEvidence(gameId: string): Promise<TerminalSettlementEvidence | null>;
  chainGame(chainGameId: string): Promise<{ game: unknown /* the RAW contract GameResponse, already validated by parseGameResponse */; provenance: "chain-confirmed" | "chain-observed"; height?: string; observedAt: string } | null>;
  escrowPin(): { contract: string; chainId: string; denom: "ujunox" } | null;
  product(): Product;
  now(): number;
}
export interface LudumCaller { principalId: string | null /* null = signed out */ }
export type LudumHandler = (body: unknown, caller: LudumCaller, ports: LudumPorts) => Promise<{ status: number; json: unknown }>;
```

---

## 10. Integration and verification procedure (coordinator)

1. **Merge order.** `ludum/baseline` (step 0), then A, then C, then B2, onto `ludum/integration`, cut from `ludum/baseline`. B1 merges
   independently in the `ludum` repo. Check that each lane touched only the paths it owns:
   `git diff --name-only <base>..<lane>` checked against section 3.
2. **Targeted tests only.** Never run the full suite.
   - `cd server && npm run build`, then `node --test` on:
     - `dist/server/src/ludum/**/*.test.js`
     - `dist/server/src/identity/live2bIdentity.test.js`
     - `dist/server/src/identity/p3AccountPolicy.test.js`
     - `dist/server/src/escrow/escrow4Money.test.js`
     - `dist/server/src/escrow/jx6bDisputeServer.test.js`
     - `dist/server/src/escrow/juno/uni7LudumGovernance.test.js`
   - Frontend: `react-app-rewired test --watchAll=false` on `sessionBootstrap` and `p3AccountSession`, plus A's new
     return-to test.
3. **Security assertions** (in A's tests, re-run at integration):
   - No `Set-Cookie` on any ludum route.
   - No CORS headers on any non-ludum route.
   - A non-allow-listed Origin gets 403 with no ACAO.
   - A revoked session gets `signed-out` on the next ludum call.
   - A provisional or unprofiled session reads as signed-out.
   - A body over 1 KiB or with unknown keys gets 400.
   - The `GS_LUDUM_ORIGINS` origin still gets 403 on `/gs/api/account/*` and `/gs/api/money/*`.
   - **Negative CORS tests (required):** each case below gets `403` with **no** `Access-Control-*` header, on both OPTIONS
     and POST:
     - `Origin` values: `https://evil.example`, `null`, missing, `http://ludum.netadao.org`,
       `https://ludum.netadao.org:8443`, `https://ludum.netadao.org/`, `https://ludum.netadao.org.evil.example`,
       `https://evilludum.netadao.org`, `https://LUDUM.netadao.org`;
     - two `Origin` headers.
   - POST with `text/plain`, `application/x-www-form-urlencoded` or `multipart/form-data` gets `415` or `400` before the
     session is read.
   - `GET`, `PUT` or `DELETE` on the prefix gets `405`.
   - An allowed preflight returns exactly the §2.1 headers: never `*`, always `Vary: Origin`, no cookie read.
   - An allowed-origin `401`, `404` or `429` still carries the exact ACAO and `Access-Control-Allow-Credentials: true`.
   - These cookies resolve to `signed-out`, with no `Set-Cookie`:
     - a rotated predecessor cookie, within its 24 h bootstrap window;
     - an idle-expired cookie;
     - a cookie from a family revoked by password change;
     - a duplicate `__Host-gs_session` cookie;
     - a look-alike cookie name.
   - The money, identity, conduct and trust handlers' existing tests still pass unchanged.
   - **CSP and script checks (Ludum repo):**
     - `node platform/tools/check-scripts.mjs` passes.
     - Every page under `me/`, `disputes/` and `governance/` has the §2.4 meta CSP as the first `<head>` child, and no inline
       `<script>`.
4. **Money assertions** (in C's tests):
   - Every ledger route (settled, annulled, cancelled, withdraw, uphold-forfeit, replace, liveness) against `fakeJunoChain`.
   - `net` is exact integer arithmetic.
   - `total_juno_pool` is never read (grep test).
   - In-game dollars never appear in a `Junox`.
5. **Governance assertions** (B):
   - The proposal JSON builder is golden-tested against section 6.
   - Pin mismatch refuses.
   - The deadline guard holds.
   - Link-by-decoding ignores look-alike proposals.
   - One dry run of `simulate` for the propose tx against uni-7, read-only. **No broadcast without the owner.**
6. **Deploy, each step a separate owner-scoped procedure.** Server image, then Ludum origin config, then the Play frontend,
   then the Ludum site.
   - Verify with a live `curl -X OPTIONS -H 'Origin: https://ludum.netadao.org'` (expect 204 and the §2.1 headers) and with
     `-H 'Origin: https://evil.example'` (expect 403, no `Access-Control-*`).
   - Then call `session` from `https://ludum.netadao.org` in a browser. The browser console must show no CSP violations,
     with the radio both off and on.
   - Then sign out on Play and confirm Ludum shows signed-out.
   - The first real appeal proposal is a Phase-4 or real-dispute event. It is never manufactured, and no PASS is claimed
     before it happens.

---

## 11. Baseline, branches and worktrees

**Baselines.**
- 1830Juno: `ludum/baseline` = the architecture commit on `phase3/consolidated-final-preplaytest-integration`, plus the
  coordinator's step 0 commit.
- `cosmonought/ludum`: `main` @ `c85b0b6`.

**Worktrees.** Every lane works in its own git worktree, so the main checkouts are never switched or dirtied. The 1830Juno
checkout holds the owner's uncommitted Phase-3 edits; the `ludum` checkout is used by the Claude Design / Cowork work.

| Lane | 1830Juno worktree / branch (from `ludum/baseline`) | ludum worktree / branch (from `main` @ `c85b0b6`) |
|---|---|---|
| **B1 (P3-critical)** | none | `C:/Users/Bradshaw/Documents/GitHub/ludum-wt/b1-appeals` / `platform/b1-appeals` |
| A | `C:/Users/Bradshaw/Documents/GitHub/1830Juno-wt/lane-a` / `ludum/lane-a-identity` | `C:/Users/Bradshaw/Documents/GitHub/ludum-wt/a-session` / `platform/a-session` |
| C | `C:/Users/Bradshaw/Documents/GitHub/1830Juno-wt/lane-c` / `ludum/lane-c-history` | `C:/Users/Bradshaw/Documents/GitHub/ludum-wt/c-history` / `platform/c-history` |
| B2 | `C:/Users/Bradshaw/Documents/GitHub/1830Juno-wt/lane-b2` / `ludum/lane-b2-case` | B2's page change lands on `platform/b1-appeals` after B1 is reported |

**Rules for every lane:**
- Never push, merge or check out `main` in either repo. Pushing to `cosmonought/ludum` `main` publishes the site.
- Commits stay local in the worktree. The coordinator integrates.
- A new 1830Juno worktree has no `node_modules`. Before building, run `npm ci` in `server/` **and** `frontend/` of that
  worktree; the server's `tsconfig` borrows `../frontend/node_modules/@types`.
- If the Cowork work changes a file a lane reads (for example `ludum.css`), the lane rebases its own branch onto the new
  `main`. It never edits that file.

---

## 12. Source integration record (coordinator, 2026-10-09)

**Branches.** `ludum/integration` in 1830Juno, and `platform/integration` in `cosmonought/ludum`. Neither is merged to `main`
or pushed; nothing is deployed.

**Lanes integrated:**

| Lane | Commit | Repo |
|---|---|---|
| A | `17e77b8e` | 1830Juno |
| A | `e6cb643` | ludum |
| C | `d36e0582` | 1830Juno |
| C | `692bf23` | ludum |
| B2 | `05b6bb45` | 1830Juno |
| B1 | `28c57fb`, `4b63b75` | ludum |

Each lane was merged with `--no-ff`, which kept its own commits. There were no textual conflicts.

**Integration defects found and fixed:**
1. **Chain port form.** Lane A's `MoneyTables.ludumChain.game` returned `parseGameResponse`'s *output*, which broke two
   handlers:
   - B2's `case` handler re-parses `read.game` and refused it.
   - Lane C lost `subsidy_paid`, `disputed_at`, `resolution`, `resolved_at`, `bond_returned` and `bond_to_pool`.

   The port now returns the **raw contract `GameResponse`, after `parseGameResponse` has validated it** (§9 comment
   amended). `server/src/ludum/integration.test.ts` proves the seam through the real wiring, and fails against the old
   form.
2. **Registry test.** It asserted the step-0 placeholders (503). It now asserts the integrated contract:
   - profiled routes answer 401 `signed-out` to a signed-out caller, both at handler level and through the ingress;
   - signed in, they answer from the ports;
   - `case` is public.
3. **Ledger sign convention.** §4 now states it: entry amounts are non-negative magnitudes, the kind gives the direction,
   and only `net` may be negative. Tests codify it.
4. **Incomplete game index.** `LudumPorts.records()` now refuses (the ingress answers 503 `unavailable`) while startup
   discovery has not finished, has failed, or reported store faults. A partial index is never served as a whole history.

**Archived-history status:**
- **Production (AWS) storage is complete.** It lists every game ever written (the `DIR#<yyyymm>` directory). Nothing moves
  archived records, and discovery loads archived records into the index.
- **Remaining gaps, recorded as release items:**
  - **Unreadable records.** A game whose record cannot be read or parsed (`discovery` record `null`) cannot be attributed
    to any account, and is absent from that account's history without notice.
  - **File storage only.** `gamesDoctor gc` moves archived games older than 90 days into `archive/<id>/`, which the
    record store does not list. Their history is unavailable in file mode. Production does not use file mode.
  - **No-money outcomes.** These remain `unavailable` ("replay required"), as designed.

**Conduct boundary.** No module under `server/src/ludum` reads the conduct store, the trust facts or the reviewer
configuration, and a test enforces this. The governance pages grant nothing to site moderators.

**Navigation.** Governance stays provisionally in the footer. Links from the existing pages to `/me/`, `/disputes/` and
`/governance/` are the design work's hand-off.

---

## 13. Delivering `ludum_origins` to staging (source ready; NOT performed)

**Source.** The source changes are:
- `modules/app` `var.ludum_origins` (default `[]`), validated:
  - at most 8 distinct origins;
  - each a lower-case `https://host`, with no port, path, query, wildcard or trailing slash;
  - never also an `allowed_origins` (Play) origin.
- The runtime document gains `ludum_origins` ONLY when that list is non-empty. With `[]`, the document is byte-identical
  to before (pinned by the existing fixture test and the new runs).
- `stacks/app` passes `ludum_origins` through to the module.
- Nothing changes in the single-host module, its `user_data` or `server.env.tftpl`. Nothing changes in ECS env, IAM,
  edge or ECR.
- The server keeps refusing `GS_LUDUM_ORIGINS` in AWS mode, so the document is the one source.

**Drift guard.**
- The certified-Terraform drift guard (base `083d066`) admits this delta ONLY as a third pinned exception:
  `server/src/aws/deploy/ludumOriginsTerraformWiring.patch`.
- Like Escrow 2.1's, it is pinned by its SHA-256, its exact files, its exact line counts and its exact hunks.
- The guard reverse-applies it BEFORE the Escrow 2.1 hunks.
- Any extra, altered, moved or missing line fails. A Ludum origin anywhere in the single-host module is unadmitted drift.

**The new gate.** `migration-guard ludum-origins` judges the delivery plan (`planGuards.ts`; tests in
`ludumOriginsGate.test.ts`).

**Staging input.**
- The ops repository holds a NEW app tfvars: the current staging inputs (`compute = "none"`, `allowed_origins =
  ["https://play.netadao.org"]`) plus `ludum_origins = ["https://ludum.netadao.org"]`.
- The current file is not edited.
- The file name and sha256 are recorded in the integration report.

**Why the app stack is no longer frozen.**
- §0.2 of `SINGLE_HOST_MIGRATION.md` froze it because of the ECS desired-count drift. Staging destroyed the ECS era on
  2026-10-04 (compute-none: 71 destroyed; the app state is 11 objects, none ECS-era).
- On 2026-10-09 the escrow 2.1 cutover planned the app stack untargeted (0/2/0), and the follow-up plan showed "no
  changes".
- Even so, this delivery goes through the guard `migration-guard ludum-origins`. It fails closed on any ECS-era object or
  any change other than this one field. It needs no ordinary apply exception.

**Release order.** An older server refuses an unknown runtime-document field, so the order is fixed:
1. **Server image first.** Build and deploy the image that contains Lane A (`ludum/integration` or later) with the
   existing single-host release procedure (`build-image`, `gs-host deploy`).
   - That server reads the current document, which has no field, and serves `/gs/api/ludum/v1/*` to Play's origin only.
   - Verify with `gs-host status`, and record the digest.
2. **The document.**
   - From a clean checkout of the reviewed commit, run `plan-evidence -Stack app -KeepPlan` with the new tfvars.
   - The plan must be 0/1/0: `aws_ssm_parameter.runtime["p1"]` updated in place, nothing else.
   - Run `migration-guard ludum-origins --ludum-origins https://ludum.netadao.org --commit <sha>`, which must PASS.
   - With the owner's GO, apply EXACTLY that `stack.tfplan`.
   - A post-apply plan must show no changes.
3. **Restart.** `gs-host stop`, then `gs-host deploy` of the SAME digest. The server reads the latest document at startup.
4. **Verify acceptance.**
   - The startup log prints the runtime document, with `ludum_origins` present.
   - `gs-host status` shows READY.
5. **Verify origins.** From outside:
   - `curl -X OPTIONS -H "Origin: https://ludum.netadao.org" https://play.netadao.org/gs/api/ludum/v1/session` gives 204
     with the §2.1 headers.
   - The same with `Origin: https://evil.example` gives 403 and no `Access-Control-*` header.
   - `POST /gs/api/account/me` and `/gs/api/money/config` with the Ludum origin give 403.
   - Finally, from the browser at `https://ludum.netadao.org/me/`: signed out, then signed in on Play, then signed out
     again.

**Rollback.**
- To remove the field: run the same guarded procedure with the tfvars `ludum_origins = []` and `--ludum-origins none`,
  then restart.
- To roll back the image to a pre-Lane-A build, the document must lose the field FIRST, because the older parser would
  refuse to start.
- Escrow 2.1's `target/escrow21-cutover/rollback/ROLLBACK.md` (old image `df981e83`) is therefore only valid while the
  document carries no `ludum_origins`.

**Not done here:** none of these steps has been performed. There was no image build, no plan against AWS, no apply and no
restart.
