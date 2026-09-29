# LIVE-4 compatibility model — the canonical description

**Status:** canonical for LIVE-4 (combined integration `6da8a1f`, corpus-gate certified; this description written by
L4-6). The code is the authority; this page says what it means and where it lives. Per-pass evidence is in the
Project reports (`claude/LIVE4_*`), chiefly `claude/LIVE4_INTEGRATION_HARDENING_2026-09-28.md`.

> **The one rule this page exists to protect.** No compatibility question in LIVE-4 is answered by
> `BUILD_ID == stored_build` or `client_build == server_build`. The build id is **diagnostic**. The only place a build
> is still compared is the **legacy protocol-0 wire**, which keeps its pre-LIVE-4 behaviour until it is retired. A
> future change that makes a build id decide whether a game continues, or whether a protocol-1 client may play, is a
> regression, whatever it is called.

---

## 1. Four identities — none of them is a Git build

| # | Identity | What it names | Where it lives | Current value |
|---|---|---|---|---|
| 1 | **Gameplay / rules** | Which authoritative reducer a game's log is a program for | `RULES_ENGINE_VERSION`, `SUPPORTED_RULES_ENGINE_VERSIONS` (`frontend/src/gameEngine/rulesVersion.ts`); stamped per deal as `SetupGame.rules_engine_version` | **11**; reads **[11]** |
| 2 | **Hosted / session protocol** | The meaning of a game's durable history *outside* the reducer (the log and its commit protocol, the server-built deal, the seal, the GameRecord's log-implied fields) | `HOSTED_PROTOCOL_VERSION` (`frontend/src/gameEngine/protocolVersions.ts`); stamped per deal as `SetupGame.hosted_protocol` (absent = 1) | **1** |
| 3 | **Financial / settlement** | The meaning and format of every durable financial artifact and every money-lifecycle rule; which rules versions may be settled; the settlement byte codec | `FINANCIAL_PROTOCOL_VERSION` (`protocolVersions.ts`); `SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS` (`settlementAppraisal.ts`, an explicit literal); the codec id `18JUNO/v1`; frozen per money game in its continuation identity (`18COSMOS/MONEY-CONTINUATION/v1`); money GameRecords are `record_schema: 2` | financial **3**; settles **[10, 11]**; codec **18JUNO/v1**; money records schema **2** |
| 4 | **Client compatibility** | The wire between a bundle and a server: frames and fields on both sockets, close codes, the `/gs/api/*` routes and bodies | `CLIENT_PROTOCOL_VERSION`, `ACCEPTED_CLIENT_PROTOCOLS` (`protocolVersions.ts`); announced per connection as `cp` / `cr` / `cb` | client **1**; server accepts **[0, 1]** |

Each axis is hand-bumped with its own changelog row, and **every bump question is asked in both directions**
(`protocolVersions.ts`, D4-17): would the new build read an old artifact differently, and could an older build with
the *same* versions misread what the new one writes. Equal versions must mean *mutually* readable and continuable.

**Not an identity:** the build id (`BUILD_ID` / `--build` on the server, `REACT_APP_BUILD_ID` / `cb` on the client),
the commit, the build time, the rules *revision* (`variants.rules`, a per-table switch the reducer branches on), keys
and key ids, endpoints, the Juno config file's format. They are printed and stamped as history; nothing continues or
refuses on them.

### The process's capability and its key

One process serves exactly **one deployment capability** (`frontend/src/gameEngine/compat/deploymentCapability.ts`):
the rules it deals / reads / settles, the hosted and financial protocols, the settlement codecs, the escrow contract
code it speaks, the escrow deployments its configuration serves, and the client protocols it accepts. `start.ts`
takes it once from the money serving (`serving.capability`), and that one descriptor is what **every** session
verdict, **every** money seam and **every** client verdict is judged against.

Its **compatibility key** is the pool's name: `dc1-` + 24 hex of SHA-256 over the canonical JSON of the descriptor.
Equal keys are one pool (a rolling replacement); a different key is a different pool. **No build id is in it.**

| Configuration | Key |
|---|---|
| No escrow configured | `dc1-68c4b829b3a20e63f3e55cde` |
| The test fixture pin | `dc1-4308649847947d1d12ccdd41` |

---

## 2. Two directions of compatibility — two different questions

### A. "Can this process continue this stored game (or deal)?" — server ↔ game

Answered by **`continuationVerdict`** (`compat/continuationVerdict.ts`), asked through the process's continuation
wiring (`server/src/continuationWiring.ts`) at **every** rebuild of a game's session, and by every money seam before
every money write (`server/src/escrow/moneyServing.ts`). Inputs: the artifacts' format classes (record, log,
financial record, ticket ledger, chain intents), the deal's **semantic** identity (rules pin + hosted protocol), the
money facts (continuation identity, write-once deployment pin), the capability, and the chain facts read **at
verification grade**. Output, in the order it is checked:

| Verdict | Meaning | Written? |
|---|---|---|
| `continues` | This pool plays and settles it | — |
| `not-continued/<why>` — `newer-format`, `older-format`, `malformed`, `legacy-unpinned`, `rules-not-supported`, `hosted-protocol`, `rules-not-certified`, `financial-protocol`, `settlement-codec`, `deployment-unavailable`, `deployment-unverified` | Derived: recomputed on every load, written nowhere. Another pool may continue it | **Never** |
| `conflict/<why>` — `deployment-conflict`, `identity-conflict`, `financial-record-missing` | Contradictory verified facts | Only the **owning** pool writes the durable hold (`CONFLICT_HOLD_CODES`); a pool that does not serve the game's escrow writes nothing |

A configuration typo is `deployment-unverified` (derived) on both sides — never a conflict. Only a chain read at
verification grade can conclude `deployment-conflict`.

### B. "Can this connected client talk safely to this process, about this game?" — client ↔ server

Answered by **`clientVerdict`** (`compat/clientCompatibility.ts`) at the upgrade and per game at every hello, submit
and push, against the **same** capability. Input: the announcement on the socket URL — `cp` (client protocol), `cr`
(the rules engines the bundle carries), `cb` (the bundle's build, **diagnostic only**) — and the game's rules pin.

| Client | Treatment |
|---|---|
| **Protocol 1** (every current bundle) | Judged by `cp` and `cr` only. `ok`; `reload` (protocol not accepted, a malformed announcement, or the game's rules are ones this server carries but the tab does not — reload once); `route` (neither tab nor server carries the game's rules — fail-closed before LIVE-6). **Its build is never compared**: a different `cb` is printed and play goes on |
| **Protocol 0** (a pre-LIVE-4 bundle; announces nothing) | Unchanged legacy behaviour: the exact build compare on `submit`, answered `build-skew`. Never sent `reload`, `route` or close 4426 (it would reconnect-loop). Retired once the first production bundle ships (that change moves the key) |

**The two questions are separate.** A game can continue here while a given tab must reload to play it (A yes, B no);
a tab can be fine while the game is not continued here (A no, B yes — the tab is told why). Neither answer is ever
derived from the other, and neither reads a build.

---

## 3. Operator surfaces (L4-6)

| Question | Where |
|---|---|
| What compatibility identity is this server serving? | The startup **banner** (`compatibility key dc1-…`, the axes, then the build marked diagnostic); **`ops/status.json`** → `compatibility` (the key, the canonical capability, the axes, `diagnostics.build_id`) and `client_answers` (reload / route / legacy-refused counts); `npm run gamesDoctor -- status` prints that file |
| What would a server started with this build and this escrow configuration serve? | `npm run gamesDoctor -- compat [--escrow-config <file>] [--build <id>]` — the same descriptor as **canonical JSON**, built with the escrow service's own constructor (`servingCapability`) and keyed with production's `compatibilityKey`. It assumes the escrow backend opens; a development server whose backend fails to open serves the no-escrow key, so the running server's banner / `ops/status.json` is the authority |
| Does this server continue each stored game, and why not? | `npm run gamesDoctor -- continuation [<game_id>] [--json] [--escrow-config <file>] [--chain]` — every stored game's **canonical** verdict, asked through production's own wiring and settlement index over **read-only** stores; beside it, what the server's discovery concludes from the files (an unpinned server deal is held `rules-pin-mismatch` before any continuation question), the artifacts' format classes, and for a money game the money seam's own verdict (the same kind of answer; a different first reason is noted, not a defect), whether this configuration **owns** it and the deployment it is bound to. Logs or holds with no GameRecord are listed as `no-record` (never served). The judgement is a production pool's: legacy (unpinned) logs are refused, as on a server without `--legacy-logs development-corpus`. `--chain` reads the configured deployment's facts at verification grade (without it no deployment conflict can be concluded) |
| A money game's full lifecycle view | `npm run gamesDoctor -- money …` (L4-4; unchanged) |

**Every inspection command only reads.** `inspect`, `continuation`, `money`, `compat`, `status`, `scan-v10` and `gc`
(dry run) never write; every file store they open reads through an adapter that refuses every write and makes no
directory (`server/src/tools/readOnlyFs.ts`), and the remaining readers (the deal and log-class readers, `scan-v10`,
the lock check) only read. The tests hash every byte of a data directory before and after each command, run as the
operator runs it. Only `release`, `reconcile-duplicate-code`, `money-release` and `gc --apply` change
anything, and only while holding the data-directory lock.

### A newer build's log (N-3)

A complete log line this build cannot read is a **newer build's format**, never a torn tail:

- the store logs `… is a NEWER build's log … it is left exactly as found and the game is not continued here` and
  refuses the load (`StoreIncompatibleError`) before any open-for-write, truncate or sync; every load repeats it;
- the session answers `not-continued/newer-format` (derived; no hold); `gamesDoctor continuation` and `inspect --deep`
  report it; `gamesDoctor release` / `money-release` refuse it;
- `logDoctor` refuses to "repair" it. `--repair --newer-is-damage` writes a **copy** only, for an operator who knows the
  line is damage; `npm run replay` refuses it with its own message (exit 3);
- a genuinely torn tail (an unterminated fragment, this build's own in-flight lines) keeps its recovery, and valid-JSON
  damage claiming this build's next index is still `corrupt` (held).

### A change in the chain's facts stops resident games

When a verification-grade chain read changes the facts for a deployment, the process re-asks every resident game's
verdict (`reviewContinuation`: the room host, each actor, each session). A game the money side now finds in a
verified deployment conflict stops at once on this pool; nothing is reloaded or written by the review.

---

## 4. Deployment requirements handed to LIVE-5

**HARD REQUIREMENT — the edge must preserve the query string on `/gs*`.** A current browser announces its client
identity on the socket URL: `/gs?cp=1&cr=11&cb=<build>`. The load balancer / CDN / proxy in front of the game server
must forward the **path and the full query string unchanged** on every `/gs` WebSocket upgrade (and must not strip
or rewrite query parameters for `/gs*` generally).

*Failure mode:* if `cp`, `cr` and `cb` are stripped, the server sees a socket that announces nothing and treats a
**current** client as a **protocol-0 / legacy** client: it gets the legacy exact-build compare (`build-skew` on any
build difference), is never told to reload when it lacks a game's rules, and never receives the protocol-1 answers.
Nothing is corrupted, but every rolling deploy would look like build skew to every open tab. LIVE-5's edge
configuration must include a check for this (the local `server/playtest-proxy.js` forwards `req.url` verbatim).

**`/gs/api/*` needs no client announcement in LIVE-4 (decision, L4-6).** No `/gs/api/*` route takes part in a
gameplay or client-compatibility decision today:

- `session`, `profile/*`: identity only — rules-independent.
- `money/*`: every write is gated **server-side** by the canonical continuation verdict (L4-4); the caller's session
  decides the seat. `escrow-details` returns the server's signed payload, which the browser re-derives from its **own
  socket-delivered log** under the server's replay policy — an unsupported pin reads "unavailable" there (no early
  approval), which is fail-safe. The browser signs only for the deployment pinned in its own build.
- The client protocol's changelog already covers `/gs/api/*` routes, shipped server-first and additively; a
  route change that would need negotiation is a client-protocol bump.

So the socket announcement is sufficient for LIVE-4, and the preflight's `x-gs-client` HTTP header was **not**
added. **Registered for LIVE-5 / LIVE-6:** introduce an HTTP client announcement (e.g. `x-gs-client`) only if API
traffic starts to need compatibility negotiation — a breaking route change, a route whose answer depends on the
client's rules, or routing API calls between pools.

---

## 5. What the combined integration closed (reference)

Evidence: Project `claude/LIVE4_INTEGRATION_HARDENING_2026-09-28.md` (the corpus-gate addendum: 539/539 frontend
suites, 10,311 tests; server 619 = 618 + the FI-22 environment skip; smoke; `scan-v10` clean).

- **N-3:** complete newer-format log records are preserved byte for byte and treated as derived incompatibility, not
  torn-tail corruption; genuine torn-tail recovery is preserved.
- **One chain-facts runtime:** the session and the money seams read the same verification-grade chain facts, so they
  give the same answer on every money fact (another deployment and a typo are derived on both sides; a verified
  contradiction is a conflict on both). Where several artifacts are unreadable at once the two may name a different
  first reason (the money seam stops at an unreadable financial record before reading the log) — both "not continued",
  neither writes; `gamesDoctor continuation` shows both.
- **One deployment capability per process** (`start.ts`: `serving.capability`).
- **Protocol-1 client compatibility** (L4-3), with the legacy wire untouched.
- **Cryptographic room seeds** (L4-5: `crypto.randomInt`).

Open for L4-7 (not changed by L4-6): the integration report's §13 L4-7 list (I-1 submit-time re-check for money
tables, N-2 `reconcileAtStartup` on a failed log-class read, an explicit future log-format marker, the ticket-ledger
format version, L4-3 F2/F7/F8 and the `read-only`/`watch-only` tolerance unions, L4-2 review F4).
