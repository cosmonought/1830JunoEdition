# LIVE-4 compatibility model — the canonical description

**Status:** canonical for LIVE-4 — **certified and closed by L4-7** (the final independent certification: `f1736bf`
plus a documentation-only evidence commit, on L4-6's `89a4b5b`, on the corpus-gate-certified integration `6da8a1f`);
this description was written by L4-6 and amended by L4-7 (§2 A, §3, §5, §6). The code is the authority; this page
says what it means and where it lives. Per-pass evidence is in the Project reports (`claude/LIVE4_*`), chiefly
`claude/LIVE4_INTEGRATION_HARDENING_2026-09-28.md` and `claude/LIVE4_L4_7_FINAL_CERTIFICATION_2026-09-29.md`.

> **The one rule this page exists to protect.** No compatibility question in LIVE-4 is answered by
> `BUILD_ID == stored_build` or `client_build == server_build`. The build id is **diagnostic**. The only place a build
> is still compared is the **legacy protocol-0 wire**, which keeps its pre-LIVE-4 behaviour until it is retired. A
> future change that makes a build id decide whether a game continues, or whether a protocol-1 client may play, is a
> regression, whatever it is called.

---

## 1. Four identities — none of them is a Git build

| # | Identity | What it names | Where it lives | Current value |
|---|---|---|---|---|
| 1 | **Gameplay / rules** | Which authoritative reducer a game's log is a program for | `RULES_ENGINE_VERSION`, `SUPPORTED_RULES_ENGINE_VERSIONS` (`frontend/src/gameEngine/rulesVersion.ts`); stamped per deal as `SetupGame.rules_engine_version` | **12** since ROUTE v12 R12-2 (11 at LIVE-4); reads **[12]** |
| 2 | **Hosted / session protocol** | The meaning of a game's durable history *outside* the reducer (the log and its commit protocol, the server-built deal, the seal, the GameRecord's log-implied fields) | `HOSTED_PROTOCOL_VERSION` (`frontend/src/gameEngine/protocolVersions.ts`); stamped per deal as `SetupGame.hosted_protocol` (absent = 1) | **1** |
| 3 | **Financial / settlement** | The meaning and format of every durable financial artifact and every money-lifecycle rule; which rules versions may be settled; the settlement byte codec | `FINANCIAL_PROTOCOL_VERSION` (`protocolVersions.ts`); `SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS` (`settlementAppraisal.ts`, an explicit literal); the codec id `18JUNO/v1`; frozen per money game in its continuation identity (`18COSMOS/MONEY-CONTINUATION/v1`); money GameRecords are `record_schema: 2` | financial **3**; settles **[10, 11, 12]** (12 since ROUTE v12 R12-3; [10, 11] through LIVE-4); codec **18JUNO/v1**; money records schema **2** |
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
| No escrow configured | On `phase3/v13-settlement-certification` (rules 13, settlement `[10, 11, 12, 13]`, not merged): `dc1-e8d0b4792a7ba07e67199ad2`. On `phase3/w3-k-rules-v13` (rules 13, settlement `[10, 11, 12]`, not merged): `dc1-390107d5e7024f4a9180efeb`. `dc1-41eb96a737cd33aa90a62808` (rules 12, settlement `[10, 11, 12]`, ROUTE v12 R12-3); R12-2's was `dc1-ade748b9407a3db380e5ed72`; LIVE-4's rules-11 key was `dc1-68c4b829b3a20e63f3e55cde` |
| The test fixture pin | On `phase3/v13-settlement-certification` (rules 13, settlement `[10, 11, 12, 13]`): `dc1-32fcc4967978e78f10874490`. On `phase3/w3-k-rules-v13` (rules 13): `dc1-d01c50c4a70d0dc14cdf915d`. `dc1-63af8114005a5f202d7d349c` (R12-3); R12-2's was `dc1-eb48b18e50d46d0c50807710`; LIVE-4's rules-11 key was `dc1-4308649847947d1d12ccdd41` |

The key moves whenever an axis moves: R12-2's rules bump (11 → 12, settlement still `[10, 11]`) is a new pool, so a
v11 server and a v12 server never share one, and a stored v11 game is `not-continued` on a v12 process. R12-3's
certification of 12 (settlement `[10, 11, 12]`) moved the keys again: the certified list is part of the rules axis.
Phase 3's dedicated v13 certification (settlement `[10, 11, 12, 13]`, gameplay still `[13]`) moved them once more.

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

**A verified conflict outlives the process (L4-7).** The chain's facts live for one run; a financial hold is durable.
So the owning pool writes a verified conflict's canonical hold (`binding-mismatch`) **the moment it learns the facts**
— the chain-facts listener (`listenForChainFacts`: `start.ts` and the tests assemble the same function), not the next
five-minute sweep — and a clean stop waits for it (bounded). That hold is the one exception to ESCROW-3A's "the first
hold stands": it **supersedes** a weaker hold the record was already under (keeping the phase it was held from, and
naming the first hold in its detail and its transition line), so a verified conflict is always recorded, and always
under that code. **A run that has not read the deployment at verification grade yet (a restart, an unreachable chain)
does not continue a game held `binding-mismatch`** — `not-continued/deployment-unverified`, derived, written nowhere,
never a second hold. Once the chain is read, the facts decide as before: a contradiction is the conflict again;
agreement continues a game loaded after the read (its money stays held until an operator's `money-release`, which needs
an agreeing verification-grade read: `--chain`). Any other hold is unaffected: gameplay continues while its money waits.
Before L4-7 a restarted pool played a conflicted game until its first chain read, and indefinitely while the chain was
unreachable.

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

**The exact boundary (L4-7).** The review is queued on **every** resident game in the same synchronous step as the
facts change (before L4-7 it ran game after game, so a game late in the pass kept admitting new moves while the
earlier games' queues drained), and it is an *essential* actor task: never refused for a full queue, never expired
behind a slow task (a dropped review left the game served). What was already queued on a game's actor when the
contradiction was recorded may still commit — an admitted move completes, and the log stays canonical; anything that
arrives after it is refused on every game. A newly loaded game asks the verdict at its load. Money: every money seam
asks the verdict again before it writes, and the owner holds the game at once. The last check before a chain
transaction is the relayer's admission: an intent admitted after the change is refused (so a checkpoint job that was
already running signs at most its one intent, and that intent is never attempted on chain); an intent the relayer had
already admitted when the facts changed completes the attempt it was on — the same boundary as an admitted move, and
nothing is admitted after it. The review is one way: a game it stopped stays stopped until its actor is reloaded, even
if a later read agrees (fail-closed; a held game's money waits for an operator's release anyway).

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

The integration report's §13 L4-7 list is dispositioned in §6.

---

## 6. L4-7 — the final certification (reference)

Evidence: Project `claude/LIVE4_L4_7_FINAL_CERTIFICATION_2026-09-29.md`. The certification's own regression suites
are `server/src/rooms/live4Certification.test.ts` (the race boundary, the restart rule, precedence, key agreement
across real processes, the edge, the stored-data matrix over file stores with every byte hashed, the release path,
the restart / reconnect matrix) and `frontend/src/utils/live4Certification.test.ts` (the socket inventory, by source
and by behaviour).

**Repaired by L4-7 (no version or key moved):**

- the continuation review is queued on every resident game at once, and is never dropped (§3, "The exact boundary");
- a verified conflict is written down when it is learned (the chain-facts listener's `holdConflicts`), superseding a
  weaker hold, and a game held for it is not continued by a run that has not read the chain (§2 A).

**Dispositions of the integration report's L4-7 list:**

| Item | Disposition |
|---|---|
| I-1 (a submit-time verdict re-check for money tables) | Not added: the actor queue is the exact boundary (§3), now the same on every resident game, and every money write re-asks the verdict. Pinned by the certification suite |
| N-2 (`reconcileAtStartup` reads a failed log-class read as `current`) | Accepted (Low): that answer only decides whether to load the game, and the load's session classifies its own log; no write follows from it, and step −1 reads the class again before any money write |
| An explicit log-format marker | For the next log-format change: N-3 recognises a newer build's lines by position and shape; a new log format should carry an explicit format / version marker |
| The ticket-ledger format version (OD-L4-4-5) | At the next financial-protocol bump (unchanged) |
| Session vs money seam first reasons (L4-6's observation) | Accepted: always the same class, never a write, deterministic within each; `gamesDoctor continuation` notes the difference and does not call it a defect |
| L4-3 F2 (the `legacy-refused` wording), F7 (a submit after a terminal answer), F8 (the server's unreachable `not-here` branch), the `read-only` / `watch-only` tolerance unions | Kept as they are: protocol 0 is not retired in LIVE-4; F8 stays as a guard; the unions go when no older server exists |
| `x-gs-client` on `/gs/api/*` | Not needed for LIVE-4 (§4); registered for LIVE-5 / LIVE-6 |
| L4-2 review F4 (a failed `refresh` at money-table creation) | Accepted (fail-closed: such a table is not continued until its actor reloads; nothing is written for it) |

**Accepted residuals (Low / Info; the L4-7 report has the reasoning):** the review is one way (above) — after a
restart, a game held `binding-mismatch` that a tab opened before the first chain read stays stopped until its actor
reloads or an operator releases it, even if the read agrees; the relayer's in-memory `skip` of such a game's intents
lasts for the process; a hold the escrow service writes reaches the session's copy of the money facts at the
coordinator's next read (the money seams read the store fresh); the settlement coordinator's startup walk reads a failed
log-class read as `current` (only a load follows, and the load classifies its own log); a log whose lines parse but
carry a newer build's message kind has its torn (never acknowledged) tail cut by the store's load before the session
calls it `newer-format` — its complete lines are never touched; the player sentence for `deployment-unverified` names
the escrow "not served here" (the restart window included); `holdConflicts` decides each game on the facts current when
it reaches it (a contradiction already superseded by an agreeing read is not recorded), and a crash before its pass has
written every hold (milliseconds per money game) leaves the next run to learn the conflict again from the chain; the
join admission, like the relayer, may complete a signature whose verdict was asked just before the facts changed (the
browser's own checksum check and the chain's code still bind the deposit); a weaker hold that arrives after a conflict's
hold is dropped by "the first hold stands" (as before L4-7; it holds itself again at its next observation), and a
release of a superseding hold lifts the hold it superseded too (its audit line names both).

**No version moved (D4-17, asked both ways).** A financial-protocol-3 build reads a superseded record exactly as L4-7
does (the same code, the same `from`, the same release rule), and every older record means what it meant; the step-7
rule is a derived refusal from missing runtime input, not a new reading of a durable artifact. **The caveat is
operational, for LIVE-5:** a same-key rollback to an L4-6 build loses the two protections (the restart rule and the
supersede) — not correctness — so a pool mixing L4-6 and L4-7 instances must be treated as lacking them.
