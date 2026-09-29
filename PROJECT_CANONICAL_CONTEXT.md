# PROJECT_CANONICAL_CONTEXT — 1830: Juno Edition (18Cosmos)

**Read this file first.** It is the small, current map of the project. It states where things stand, which documents
are the current truth, what must not change, and how work is done here.

**Last updated:** 2026-09-29, by LIVE-5 L5-5 (the DynamoDB signing ledger, the AWS KMS signer binding and configuration v3, §A "LIVE-5"; built and conformance-tested, not wired into production startup -- L5-7; no rules, settlement, protocol or escrow byte moved; money games stay off in production), integrated onto `main` after ROUTE v12 R12-1, L5-2 and L5-4.

**Before that:** 2026-09-29, by LIVE-5 L5-4 (identity on DynamoDB and the identity-side security substrate, §A "LIVE-5"; built and conformance-tested, not wired into production startup -- L5-7; no version or protocol moved), integrated onto `main` after L5-2 and ROUTE v12 R12-1; before it by LIVE-5 L5-2 (the DynamoDB game-table adapters, §A "LIVE-5"; not wired into startup; no version or protocol moved), and before that by LIVE-5 L5-1 (the persistence conformance and fault-injection foundation).

**Earlier:** 2026-09-29, by LIVE-4 L4-7 (the final independent certification: the certified commit `f1736bf` on L4-6's `89a4b5b`, then one documentation-only commit recording the final evidence and the owner's gate rule, §E): **LIVE-4 is certified and closed; LIVE-5 is next** (§A "LIVE-4"). The canonical description of LIVE-4's compatibility identities is [`LIVE4_COMPATIBILITY_MODEL.md`](LIVE4_COMPATIBILITY_MODEL.md).

**Previously updated:** 2026-09-29, by LIVE-4 L4-6 (the tooling / diagnostics / runbooks / canonical-documentation pass on the combined LIVE-4 integration `6da8a1f`).

**Earlier:** 2026-09-28, by the integrated closure of ESCROW-4 (`031593e`), Phase 6.5-B (`ddf4bc8`) and APP-TEST-0A (`467498e`): the owner broad gate was GREEN at `467498e`, and one closure commit on top hands the settlement band the live board and closes the bookkeeping (§A). ESCROW-4 is the player-facing Juno escrow path (Keplr wallet proof, funding, Start, consent keys and the settlement UX; financial protocol 3; money GameRecords `record_schema 2`). It builds on ESCROW-JOIN (`6f05c80`), ESCROW-3B (`5298d95`, owner-certified), ESCROW-3A (`900aec3`), DA-8 (`81fd037`), the prune (`68f6baf`) and ROADMAP 3.2 (`4f3baa3`).

**Where the documents live.** They are in two places:

- **the repository** — this file, the living ledgers and the archive;
- **the claude.ai Project "18Cosmos_Juno"** — the per-pass Claude reports, under `claude/`.

When this file names a Project document, it writes `Project: claude/<name>`.

> **For future implementation sessions:**
> 1. Read this file first, then the roadmap in `ROADMAP_3_2_REMAINING_WORK.md`.
> 2. Then read only the canonical documents listed in §C for the current phase. For the next pass (LIVE-4), use the reading order in §C.3.
> 3. Do not read the whole of `RULES_HARDENING_BACKLOG.md`: it is 600 KB. Read the Part or item you need.
> 4. Do not recursively read `archive/`, `docs/ai_architecture/` or the Project's historical reports unless the current task requires historical provenance, or a current document points you there.

---

## A. Current project state

**Gameplay authority**
- The TypeScript reducer (`frontend/src/gameEngine/`), run by the Node server (`server/`), is the **only** gameplay authority.
- Rust/CosmWasm is **escrow, notary and settlement only** (`contracts/escrow`).
- The legacy on-chain-gameplay crate (`src/`, `tests/e2e.rs`) is awaiting retirement. See §B.

**Rules engine = v11**
- `RULES_ENGINE_VERSION = 11` (`frontend/src/gameEngine/rulesVersion.ts:65`). The supported versions are derived, so they are `[11]`.
- A v10 game is held `incompatible`. It is never reinterpreted.
- `server/data` was scanned clean with `npm run gamesDoctor -- scan-v10`.

**Phase 1 — hosted authority: CLOSED**
- LIVE-2A…2F and LIVE-3A…3D were certified **GREEN** ("ready for ESCROW-3").
- The certified tree is `0ae252d`. Record: Project `claude/LIVE2F_LIVE3D_HOSTED_AUTHORITY_CERTIFICATION_2026-09-27.md`.

**Phase 2 — Delayed Auction / rules closure: CLOSED**
- DA-8 is `81fd037`, pushed, and equals `origin/main` at the start of this prune.
- Owner gate results:
  - 513 / 513 frontend suites, 9,868 / 9,868 tests;
  - server green, smoke green;
  - production build and security scan green;
  - the v10 historical scan is clean.

**Settlement certification**
- Settlement is certified for **v10 and v11**: `SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS = Object.freeze([10, 11])` (`frontend/src/gameEngine/settlementAppraisal.ts`). It is a literal and never derived from `RULES_ENGINE_VERSION`.
- `checkPin` accepts certified pins only. Every other pin (9, 12, …) is refused with `UNSUPPORTED_RULES_ENGINE_VERSION … (supported: 10, 11)`.
- v10 is certified byte for byte, as before. v11's evidence sits beside it (`settlementV11Certification.test.ts` and `settlementV11CertificationVectors.json`). v11 payloads differ from v10 only in `domain` [1,33) and `appraisal_state_hash` [91,123). No contract, wasm or codec change was needed.
- The next rules bump is refused for settlement until its own certification pass adds it. Record: Project `claude/ESCROW3A_MONEY_GAME_PREREQUISITES_2026-09-27.md` §2–3.

**Phase 3A — money-game hosted prerequisites: COMPLETE** (ESCROW-3A; the owner gate is pending)
- The settlement seam is durable: one financial record per money game (`games/money/<game_id>.json`), keyed by `(gameId, seal.log_len)`, written by CAS, and discovered at startup. See `server/src/escrow/`.
- `sealedPrefix` is the one way to slice `log[0..seal.log_len)`.
- Post-deal cancel, refund and abandon are refused. Liveness is a state, not a refund.
- A money game carries a continuation identity: the rules, hosted, financial and codec versions.
- Wallet tickets: one per seat, ended by every security event, and frozen with the roster.
- Identity snapshot **v4** adds private session families (IR-03). Rotating the recovery key and signing out other devices need a recent re-authentication with the key.
- The recovery limiter counts failures only and never refuses the right credential.
- `gamesDoctor` gained `money`, `money-release` and `reconcile-duplicate-code`.

**Phase 3B — the Juno financial backend: COMPLETE** (ESCROW-3B, `5298d95`; owner-certified)
- `server/src/escrow/escrowService.ts` + `server/src/escrow/juno/`: sealed gameplay → certified payload → a **durable chain intent** (`games/chain-intents/`, written before any side effect) → signed (KMS-ready signer; a development key only in development, off mainnet, with an explicit switch) → journalled (the external signing journal, outside the data directory in production) → broadcast → observed on chain. One live attempt per relayer account; the sequence is always the chain's; no tx hash is ever invented.
- The financial record carried `FINANCIAL_PROTOCOL_VERSION` 2 at 3B (now **3**, ESCROW-4): the deployment pin and the chain-game binding (write-once), the frozen roster with its **epoch**, the chain progress and outcome.
- Checkpoints at the deal, every completed round boundary and the terminal seal (2L before the Settle, 2L+1), from committed boards only. Finalize only for a settlement this server signed.
- **The roster freeze is reversible until the chain confirms Start**: permanent once Start is on chain; released (pre-Start funded state) only when the chain PROVES that freeze's Start can never happen; an unknown outcome never releases.
- The wallet-ticket ledger is durable (`games/wallet-tickets/`), wired to identity's security events, frozen and released with the roster (by token).
- Startup: rosters preloaded before any chain read; the deployment verified on every configured endpoint; the durable log must reproduce the journal's signed history before anything is signed again. `gamesDoctor money` shows each intent's evidence.
- ~~PRODUCTION BLOCKER: junk-Join~~ — **CLOSED by ESCROW-JOIN** (below). 3B §18 is historical.

**ESCROW-JOIN — the contract's Join is admission-gated: COMPLETE** (the owner gate is pending)
- **Escrow 2.0.0** (`contracts/escrow`): `Join { chain_game_id, consent_pubkey, join_ticket, admission: { expires_at, signature } }`. The contract verifies, BEFORE anything is written or any fund is accepted, block time < `expires_at` and the low-s secp256k1 signature of `Config.admission_pubkey` over `SHA-256("18JUNO/JOIN/v1" ‖ lp(chain_id) ‖ lp(contract) ‖ u64(chain_game_id) ‖ lp(info.sender) ‖ ticket(32) ‖ u64(expires_at))`. A copied ticket or admission seats nobody; nothing replays across game, contract or chain.
- **The admission key** is its own key (never the relayer's or the settlement key; the contract refuses a current or former admission key as a signer key and vice versa). The admin rotates it with `SetAdmissionKey` (immediate; an in-flight Join fails and moves no funds). `migrate` refuses any state older than 2.0.0 (`MigrateUnsupported`): a 1.x deployment is replaced, never migrated.
- **Server seam:** `EscrowService.authorizeJoin` (`server/src/escrow/escrowService.ts`) issues an admission only from the existing authority (bound FUNDING game, not frozen, the seat's standing ticket issued to THIS principal for THIS wallet, a structured wallet-control proof from `WalletControlProofs` — supplied since ESCROW-4 by the wallet-link route's ADR-036 proof on the grant (before it, every admission was refused `wallet-unproven`) — no conflicting grant, chain open). It records `admitted_until_secs` on the ticket grant BEFORE signing; while an admission is outstanding the seat's ticket is not superseded. Signer: `server/src/escrow/juno/joinAdmission.ts` (KMS in production, which stays fail-closed until LIVE-5; development key only under 3B's guards). Config format **`18COSMOS/JUNO-BACKEND/v2`** requires `admission_key`; deployment verification requires the chain's `admission_pubkey` to be this server's key and refuses the 1.0.0 checksum by name.
- **Frozen cross-language vectors:** `contracts/escrow/testdata/join_admission_vectors_v1.json` (independent Python generator; Rust, contract-on-chain and TypeScript reproduce every byte).
- **No settlement byte changed** (SET-0C v10/v11 vectors, codec and appraisal untouched). Record: Project `claude/ESCROW_JOIN_ADMISSION_SECURITY_REPAIR_2026-09-28.md`.

**ESCROW-4 — the player-facing Juno escrow path: COMPLETE** (owner broad gate GREEN relative to the repository baseline; the strict `CI=true` production build stays blocked only by the pre-existing warning backlog, to which ESCROW-4 adds no warning)
- **The path:** hosted identity → 3A "Confirm it's you" → Keplr ADR-036 wallet proof (`server/src/escrow/walletProof.ts`: a server-minted, single-use challenge naming site, network, contract, table, seat and wallet; the server rebuilds cosmjs's sign doc and derives the address) → a durable seat/wallet grant carrying the proof → `authorizeJoin` (now reachable) → a `CreateGame`/`Join` **the browser builds itself** from the build's pinned deployment (`REACT_APP_ESCROW_DEPLOYMENT`) → funding **from the chain only** (a tx hash is a hint) → Start (the host; any funded player 10 minutes after full funding) with 3B's reversible freeze → the browser-held consent key (IndexedDB, stored before any deposit names it) → the settlement band.
- **Server:** `server/src/escrow/moneyTables.ts` (the seam: creation, link, admission, hints, W-13 discovery/binding of the host's CreateGame, the R-J1/W-2/W-3 seat locks, Start, the CONSENT/ANNUL relays, "Your deposits", the projections) and the `/gs/api/money/*` routes (`moneyHttpApi.ts`: POST only, allow-listed Origin, closed bodies, a per-session budget). A valid CONSENT/ANNUL signature is relayed with no re-auth (OD-4-2); creating or moving a key needs re-auth plus the wallet's `SetConsentKey`.
- **Browser:** `frontend/src/money/` and `components/money/` (the waiting room's money panel, the settlement band under the final result, "Your deposits" in the lobby, the host's stake). Before "Approve payout now" a device re-derives the recorded settlement itself (`settlementCheck.ts`: the sealed prefix replayed as the server replays it, the certified appraisal, anchored on Juno through the pinned endpoint). A device without Keplr plays normally.
- **Versions:** `FINANCIAL_PROTOCOL_VERSION` **3** (protocol-2 grant files are refused, never reinterpreted); money GameRecords are `record_schema: 2` (no-money records stay 1); the hosted protocol stays **1**; RoomView money fields are optional and additive; no rules bump.
- Record: Project `claude/ESCROW4_KEPLR_WALLET_CONSENT_2026-09-28.md` (§20 is the LIVE-4 compatibility handoff; §19 the LIVE-5/Junox handoff).

**Integrated closure — ESCROW-4 + Phase 6.5-B + APP-TEST-0A: COMPLETE** (2026-09-28)
- **The stack:** `031593e` (ESCROW-4) → `ddf4bc8` (Phase 6.5-B: the six fix-before UI items and the RR-2 copy) → `467498e` (APP-TEST-0A: the shell source-scan guards), then one closure commit. Not pushed.
- **Owner broad gate at `467498e`: GREEN.** 534/534 frontend suites and 10,160/10,160 tests with the local corpus; typecheck; `sourceGuards` / `sourceScan` and the source sweep (0 MISSING/PRESENT); the ordinary production build with exactly the historical 49 ESLint warnings and the one webpack warning; server build, `npm test` (515: 514 pass plus the historical FI-22 skip) and smoke; `scan-v10` CLEAN. Record: Project `claude/INTEGRATED_GATE_ESCROW4_65B_APP0A_2026-09-28.md`.
- **The closure:** both `SettlementBand` mounts are handed `liveState`, so a Dispute's evidence is the live board's hash, never a scrubbed round's (6.5-B review I-4; behavioural regression `components/money/settlementEvidenceBoard.test.tsx`). The 6.5-B items are closed in the backlog (Part C's Phase 6.5 register; U-19 and U-24 resolved). I-1 stays deferred (minor). Two route findings are pre-registered as blockers before any substantive G5 / LPF route playtest (Part B S6-15, S6-16). Record: Project `claude/INTEGRATED_CLOSURE_ESCROW4_65B_APP0A_2026-09-28.md`.
- **Unchanged:** rules 11; settlement `[10, 11]`; hosted protocol 1; financial protocol 3. No server, contract or engine file changed.

**LIVE-4 — compatibility and continuation: CERTIFIED AND CLOSED (L4-7); LIVE-5 next**
- **Real closure baseline:** `9c81bbd` (the integrated closure above; the real checkout's `main`).
- **The combined LIVE-4 integration / hardening:** `6da8a1f17b17cd44d31666f00de1b5480ce65754` (tree `2a488d52…`), on `9c81bbd`: the five slices L4-1 (the canonical compatibility model) → L4-2 (no-money continuation) → L4-3 (client compatibility, protocol 1) → L4-4 (money continuation) → L4-5 (cryptographic room seed), plus one integration commit. **Certified by the owner/corpus gate** (the integration report's addendum: 539/539 frontend suites, 10,311 tests, with the corpus; server 619 = 618 + the FI-22 environment skip; smoke; `scan-v10` CLEAN; the build at the 49 + 1 warning baseline). Not pushed; it lives in the sibling clone `1830Juno-L4-INT`. Record: Project `claude/LIVE4_INTEGRATION_HARDENING_2026-09-28.md`.
- **What the integration closed:** a complete newer-format log record is preserved byte for byte and is derived incompatibility (`not-continued/newer-format`), never torn-tail corruption (N-3), while genuine torn-tail recovery is preserved; the session and the money seams share one verification-grade chain-facts runtime, so they give the same answer on every money fact; one deployment capability per process (`start.ts`: `serving.capability`); protocol-1 client compatibility with the legacy wire untouched; the hosted revenue seed is a `crypto.randomInt` draw. Evidence stays in the integration report.
- **The identities** (rules / hosted / financial / client) and the two directions of compatibility (can this process continue this game; can this client talk to this process) are described once, in [`LIVE4_COMPATIBILITY_MODEL.md`](LIVE4_COMPATIBILITY_MODEL.md). **The build id is diagnostic**: no continuation or protocol-1 client decision compares builds; only the legacy protocol-0 wire keeps its exact compare (§D 5b).
- **L4-6: tooling, diagnostics, runbooks, docs.** The process's compatibility key is printed in the startup banner and `ops/status.json` (with `client_answers`); `gamesDoctor compat` prints the canonical descriptor; `gamesDoctor continuation` gives every stored game's canonical verdict through production's own wiring (read-only; money games keep L4-4's owner/deployment/format view); every inspection command reads through a write-refusing file system. The runbooks' build-equality language is corrected; the LIVE-5 edge requirement (preserve the `/gs*` query string: `cp`, `cr`, `cb`) and the `/gs/api/*` decision (no HTTP client announcement in LIVE-4) are recorded. No protocol or version moved. Record: Project `claude/LIVE4_L4_6_TOOLING_DOCS_2026-09-29.md`.
- **L4-7: the final independent certification — GREEN; LIVE-4 closed.** The certified commit `f1736bf` on `89a4b5b`, then one documentation-only commit recording the final evidence (not pushed; the sibling clone `1830Juno-L4-7`). It found and repaired LIVE-4 defects in how a verified chain contradiction is carried: the continuation review it triggers is now queued on every resident game at once and is never dropped behind a slow task (a game could keep admitting moves after the contradiction was known); the owner writes the conflict's hold the moment the facts are learned, not at the next five-minute sweep, superseding any weaker hold (the one exception to "the first hold stands"); and a game held for a deployment conflict is `not-continued/deployment-unverified` on a run that has not read the chain (a restarted server used to play it until its first chain read). It adds the certification suites (`server/src/rooms/live4Certification.test.ts`, 63 tests: the race boundary, precedence, key agreement across real processes, the edge, a stored-data matrix over file stores with bytes hashed, the release paths, restarts and reconnects; `frontend/src/utils/live4Certification.test.ts`: the socket inventory). Its full gate ran on Linux at `f1736bf` (the cloud clone, with the corpus, whose hashes did not change): frontend 540/540 suites and 10,318 tests, typecheck, the source guards and sweep, the production build at the 49 + 1 warning baseline; server build, smoke, `scan-v10` CLEAN; server `npm test` 695 = 694 + the FI-22 skip on the rerun. The first server run had one failure, in the LIVE-3C real-process test: a pre-existing timing race in that test (unchanged since ESCROW-3A), seen on the pre-L4-7 base too; not an L4-7 regression. A 27-mutation campaign was caught in full; a fresh review (four rounds) closed with no High or Medium open. Native Windows: the commit was transferred to the sibling clone and its identity verified; the broad gate was **not run there, by the owner's instruction**. No version or key moved. Record: Project `claude/LIVE4_L4_7_FINAL_CERTIFICATION_2026-09-29.md`.
- **LIVE-5 follows.** Its LIVE-4 inputs: the hard edge requirement (§D 5b; `LIVE4_COMPATIBILITY_MODEL.md` §4) and the L4-7 report's handoff list.
- **Versions (unchanged by LIVE-4's later slices, L4-6 and L4-7):** rules 11 (reads [11]); settlement `[10, 11]`; hosted protocol 1; financial protocol 3; client protocol 1, accepted `[0, 1]`; money GameRecords `record_schema 2`. Keys: `dc1-68c4b829b3a20e63f3e55cde` (no escrow), `dc1-4308649847947d1d12ccdd41` (the fixture pin).

**LIVE-5 — AWS durability: IN PROGRESS (L5-1, L5-2, L5-4 and L5-5 done; L5-3 next)**
- **L5-1: the persistence conformance foundation.** `server/src/persistence/conformance/`: one behavioural suite per store port (log, GameRecord + join codes, holds, financial record, chain intents, wallet tickets, identity, signing journal), written once and run against every implementation through `runConformance`. Each implementation declares its capabilities and any reviewed difference. The memory and file stores pass it. It also carries a deterministic fault-injection substrate (`faults.ts`: scripted fail / lose-answer / stall / duplicate / partial / short on the file seam or any port, fences with newest-writer-wins; no sleeps). Every later LIVE-5 adapter joins these suites as a subject; it does not get private tests.
- **DynamoDB Local** (`npm run test:dynamodb-local` with `GS_DYNAMODB_LOCAL_ENDPOINT`, loopback only; not part of `npm test`): tables per case, deterministic cleanup, client-level faults, and a proof-only financial adapter that passes the financial cases, including the fence inside the write and the idempotent resend. **The AWS client convention** is `server/src/aws/awsClients.ts` + `README.md`: one factory, explicit targets, SDK retries off, bounded throwing timeouts, `ignoreConfiguredEndpointUrls` for real AWS, and only `@aws-sdk/client-dynamodb` so far.
- **Fixed on the way** (narrow):
  - the file log store acknowledged a batch it could not read back. The room was held corrupt, and after a restart the log was classified as another build's; such a batch is now refused DEFINITE;
  - the memory identity store let a relation failure escape as an unknown outcome; it now refuses DEFINITE, as the production journal store does;
  - **the file signing journal** (`escrow/signingJournal.ts`, found by the review):
    - An append whose bytes may have landed left the in-memory index without the line, so the same process could then reserve and sign a DIFFERENT digest at that slot. Now any failure after the file is opened HOLDS the journal until a restart, and `start.ts` exits (`failFast`, as for every other store).
    - The append goes through the `StoreFs` seam, still in append mode. It refuses (and holds) if the file no longer ends where this instance's last line ended. A second writer on the same journal never overwrites a line: JNL-14/15. The journal directory has no lock of its own; L5-5's ledger replaces it.
- **Pinned for L5-2/4/5:** F-L5-4 (the file stores check their fence before writing), per port (`fenceGap.test.ts`). A DynamoDB subject must declare the fence inside the write, lost-answer and transient-failure injection and the idempotency token, or name an exemption.
- **Also:** the frontend lock's yaml peer was repaired (plain `npm ci` works).
- Record: Project `claude/LIVE5_L5_1_CONFORMANCE_2026-09-29.md`.
- **L5-2: the game-table adapters** (`server/src/aws/game/`; the convention: `server/src/aws/README.md` §4). DynamoDB adapters behind the six existing ports — log (+chat), GameRecord + join codes + game directory, holds, financial record (+`FINIDX#`/`FINKEYS`), chain intents (+`RELAYQ#`), wallet tickets — over one `game` table. Every write is one `TransactWriteItems` carrying its fence INSIDE the write (the game's `HEAD` owner and pool epoch; the pool's epoch for a write that makes a game or names none), one `ClientRequestToken` per logical write resent unchanged until evaluated (8-minute window; TransactionInProgress waits); a lost answer is settled by the write's token on the items (fence read alone, the target set as one snapshot); otherwise `uncertain` = the write may still land later. Size guards refuse before sending (item 350 KiB, transaction 3.5 MiB / 80 actions; a log batch ≤ 78 entries). Log lines stored verbatim (export byte-identical to a file log). Ownership primitives for L5-3 (`takeOverPool`, pool-fenced `claimGame`, `releaseGame`). **Not wired into startup** (L5-7; a source guard enforces it).
- **Changed for every backend (narrow):** the wallet-ticket port answers an explicit `uncertain` (F-L5-6 closed; the file store's unresolved replacement no longer reads as `conflict`; callers never treat it as committed); chain-intent equality (`sameChainIntent`) compares the signed content, never signature bytes (the L5-5 handoff: KMS ECDSA is not deterministic). The conformance suites gained `cas-in-write` and `inject-unevaluated` (required of every DynamoDB subject), per-port token / unknown-then-takeover / unevaluated / create-race cases and a second fence-inside-the-write case per port, each pinned against the file stores in `fenceGap.test.ts`.
- Record: Project `claude/LIVE5_L5_2_DYNAMO_GAME_STORES_2026-09-29.md`.
- **L5-4: identity on DynamoDB, and the identity-side security substrate** (`server/src/aws/identity/`; the table, keys and write design in `server/src/aws/README.md` §5). A DynamoDB `IdentityStore` for the identity writer: every precondition, every rule about a record's past and every relation is a condition of the write; every write carries the `ROLE_ID` fence and a commit marker. DEFINITE means nothing was written; an unknown outcome is resent under the same token and settled by the marker. A change too big for one transaction lands every security effect first. The adapter passes every identity case on DynamoDB Local -- ID-12 and ID-14 included -- and the new ID-15, ID-18, ID-19 and ID-20 cases; integrated after L5-2, its three DynamoDB subjects also declare L5-2's `inject-unevaluated` (ID-21, GRANT-13, SEC-11), and the identity store and the journal its `cas-in-write` (the grants subject exempts it: a grant write has no condition of its own). The security substrate:
  - durable sensitive-auth grants (OD-5-4);
  - the `SEC#` security-event journal on the ledger table, written from inside the store's commit after the store's own checks (the port's one addition, `IdentityCommitOptions.beforeWrite`), with a `confirmed` event after each committed change.
  Nothing is wired into `start.ts`: L5-7 wires it (`awsClients.test.ts` refuses any other importer of `aws/identity`, as of `aws/game`). The file stores are unchanged, apart from the new hook and one shape check. Owner Windows gate on `d064f49` GREEN (`npm test`, smoke, `scan-v10`, `test:dynamodb-local` 119: 118 pass, 1 skip). Record: Project `claude/LIVE5_L5_4_IDENTITY_2026-09-29.md`.
  **Owner decisions (2026-09-29):**
  - journal-first stays **fail-closed**: while the ledger cannot record an event, the security changes that need one answer unavailable; a recovery stays available;
  - after a restore, an **unconfirmed** recovery-key rotation retires its old selector, does **not** install the new one, and sends the profile to operator review (the L6-4 replay rule, `server/src/identity/securityEvents.ts`);
  - `createFileIdentityStore` stays **test-only**; it is not deleted during LIVE-5.
- **L5-5: the signing ledger and the KMS signer** (`server/src/aws/ledger/`, `server/src/aws/kms/`; not wired into `start.ts`: L5-7).
  - **The ledger** (`server/src/aws/ledger/dynamoSigningLedger.ts`): the `SigningJournal` port over one DynamoDB table (the preflight's ledger account). First writer wins per slot `(instance, seq, signer key)`, decided by `attribute_not_exists` inside a `TransactWriteItems`; an attempt is recorded once per transaction id (a `TXID#` item, one set of facts). **Two fences inside every write:** the adopted app generation (`APPGEN`) on all of them, and the relayer fence `(epoch, minting token)` on attempts, minted by `takeOverRelayer` (compare-and-swap; only the minting task holds it). An unknown outcome is resent with the SAME `ClientRequestToken`, then settled by reading the fences, then the targets (ours → committed; a moved fence → fenced; another value → it decides; nothing → uncertain); an ambiguous write never becomes a fresh attempt, and nothing is signed or broadcast on an error. Only a write cancelled purely by a transaction conflict (definitely not applied) is tried again, as a new request. Reads are strict: a damaged or newer item — a fence item included — refuses the whole answer, and damage is never taken for a takeover. It is a `dynamodb` subject of `JOURNAL_CASES` on DynamoDB Local.
  - **The journal port is async** (preflight §10.4, F-L5-8/F-L5-18): `reservations`, `attemptsOf`, `allAttempts(account)` return promises; `escrowService` (F1, the start release) and the relayer's forgotten-attempt guard await them, and a failed read fails closed.
  - **KMS** (`server/src/aws/kms/kmsDigestClient.ts`, `createKmsClient` in `awsClients.ts`; `@aws-sdk/client-kms` 3.1142.0 pinned): a key by its **key ARN** in the client's own region; `Sign` of exactly the caller's 32 bytes, `DIGEST` / `ECDSA_SHA_256`; every answer checked to be that key and algorithm, then verified against the key's public key (`signer.ts`). Every failure has one class (`unavailable` / `refused` / `verify-failed`, plus whether a signature may exist in a lost answer); no failure tries another key or digest.
  - **Configuration `18COSMOS/JUNO-BACKEND/v3`:** `journal: {kind: "file", dir} | {kind: "dynamodb", table_arn}` (v2 and its `journal_dir` unchanged); KMS keys by key ARN in one region (both formats). `start.ts` refuses a `dynamodb` journal (L5-7 wires it) rather than fall back to a file journal; KMS keys still refuse to open in `start.ts` (no KMS client wired until L5-7), so production stays fail-closed.
  - Record: Project `claude/LIVE5_L5_5_SIGNING_KMS_2026-09-29.md`.

**Route engine / v12: a separate gameplay program, not part of LIVE-4**
- The route / autopath hardening (the route-engine certification preflight's findings, including the pre-registered blockers **S6-15** — hosted ingress judging routes on the STANDARD board — and **S6-16** — an H12 fork reversal the search demonstrates but authority rejects) and the **v12** rules batch are their own gameplay program. They are not folded into LIVE-4 and change no LIVE-4 identity. Record: Project `claude/ROUTE_ENGINE_EXTRACTION_CERTIFICATION_PREFLIGHT_2026-09-28.md`.
- **R12-1 (2026-09-29): the independent route oracle is established** (test-only, `frontend/src/routeOracle/`; never imported by the app). It enumerates every legal route and the exact best combination from its own reading of the board, and pins every preflight defect as a KNOWN-RED fixture (red areas twice, the Altoona bow, CROSS_TWICE, the H12 fork, Coal River, ING-1, S6-15 ingress, warehouses). Production code, `RULES_ENGINE_VERSION` and settlement are unchanged. Owner-run full corpus: `ROUTE_ORACLE_FULL=1` (and `ROUTE_ORACLE_CORPUS_DIR` for the owner-local logs) on `routeOracleCorpus.test.ts`. Record and the R12-2 handoff: Project `claude/ROUTE_V12_R12_1_ORACLE_2026-09-29.md`.
- **R12-1 repair (2026-09-29): the owner's route rulings are in the oracle.** H12 herald: IL-2 yes (a virtual city on any legal PRR traversal, joining no track the tile does not join); IL-3 **no** (an uncounted pass is not a station); IL-4 yes (trains independent); IL-11 re-entry on distinct track, counted at most once, a pass never uses it up; S6-4 has **no** "must count" obligation. Warehouses: a city for revenue and capacity, counted whenever traversed, may end a route, never blocks, untokenable, no per-route cap. **Brown #62 pays $80 per city**; the catalog's $90 is a production data defect for R12-2 (not changed). **1830+ / LPF printed values (owner-confirmed from the physical board, R12-1 closure): Montreal A19 $40 / $60, Norfolk L16 $30 / $50** (the lesser until the first 5-train). **Montreal A19 and Norfolk L16 are each ONE city with TWO station slots** (ordinary blocking; N&W's home takes one of Norfolk's) — this **supersedes the earlier one-slot ruling (#1401) for both**. Production still prices both flat ($40, $20) and gives each one slot: production data defects deferred to R12-2 (locations: Project `claude/ROUTE_V12_R12_1_ORACLE_2026-09-29.md` §0C).
- **Substantive human gameplay (the G5 / LPF route playtests, the full G1/G2 games) waits for that route hardening.** The **reduced S0** human UI/evidence smoke remains available now.

**GNOLAND-1 / 1.1: complete; further Gno work parked**
- The chain-neutral escrow backend interface and the Juno regression oracle landed as `b804150`.
- Juno is the only production backend. The Gno codec is a draft whose byte methods throw `NOT_IMPLEMENTED`.
- GNOLAND-2 and later have not started.

**Money games: OFF unless the operator opens them on a non-mainnet escrow** (ESCROW-4)
- A `create` with a non-zero stake opens a real-money table only when ALL hold: `ESCROW_MONEY_TABLES=nonmainnet`; `ESCROW_JUNO_CONFIG` names a backend that verified against the chain; the network is not mainnet; the current rules are settlement-certified (else `rules-not-certified`, nothing written). Otherwise it is refused `money-games-disabled`, as before.
- A money table is `record_schema: 2` (its terms copy the server's pin); it uses `host_undo: "none"`; its deal is `EscrowService.rosterSource` (no-money tables keep `NoMoneyRosterSource`).
- The browser signs only for the escrow pinned in its build (`REACT_APP_ESCROW_DEPLOYMENT`); a mainnet class or chain id `juno-1` is refused there too.
- **Production stays fail-closed:** its keys are KMS clients (LIVE-5), so a production backend does not open in this build. No mainnet money.

---

## B. Current roadmap

**The canonical roadmap is [`ROADMAP_3_2_REMAINING_WORK.md`](ROADMAP_3_2_REMAINING_WORK.md)** (the owner's ROADMAP 3.2). It holds the phases, their status, their estimates and where each phase's scope is defined.
The owner's brief for each pass sets that pass's exact scope.

```text
Phases 1, 2, 2.5, 3A, 3B, ESCROW-JOIN and ESCROW-4: COMPLETE
→ 4: LIVE-4/5/6
→ 5: Junox E2E
→ 6: Rust retirement
→ 7: frontend cleanup
→ 8: production repo extraction
→ 9: UI/UX backlog consolidation
→ 10: UI/UX polish
→ 11: near-production playtest
→ 12: release hardening
```

Gno is parked.

**LIVE-4 status (2026-09-29): CLOSED.** Integrated at `6da8a1f` (corpus-gate certified), tooled / documented by L4-6
(`89a4b5b`) and certified by L4-7 (`f1736bf` on it, plus a documentation-only evidence commit). **LIVE-5 is in progress: L5-1 (the conformance foundation), L5-2 (the game-table adapters), L5-4 (identity on DynamoDB) and L5-5 (the signing ledger + KMS) are done, each through its owner gate; L5-2, L5-4 and L5-5 are not yet wired (L5-7); next is L5-3 (ownership).**
(the owner's brief sets its scope; its LIVE-4 inputs are the L4-7 report's handoffs and `LIVE4_COMPATIBILITY_MODEL.md`
§4). The route-engine / v12 program is separate (§A).

*Historical (the LIVE-4 entry conditions):* ESCROW-4 left the tree as the LIVE-4
compatibility preflight asked (financial protocol 3; money GameRecords schema 2; hosted protocol 1; additive RoomView money
fields; creation refusing uncertified rules). Its inputs:
- Project `claude/LIVE4_COMPATIBILITY_CONTINUATION_PREFLIGHT_2026-09-28.md` (the design);
- Project `claude/ESCROW4_KEPLR_WALLET_CONSENT_2026-09-28.md` §20 (the LIVE-4 compatibility handoff: what is durable financial v3, what is wire-only) and §19 (the LIVE-5 / Junox handoff: KMS clients for the relayer, settlement and admission keys; shared stores for the money layer's in-memory state).

**Beside LIVE-4 (human evidence, Phase 6.5).** A **reduced S0** is the lightweight human UI/evidence smoke, available on the closed tree; the full **G1/G2** games stay later, as the substantive human certification. Backlog **S6-15 / S6-16** (two route findings, pre-registered) must be fixed before any substantive G5 / LPF route playtest. **v12** (6.5-E) and the **App decomposition** (Phase 7) remain later. Rules stay **11** and settlement **`[10, 11]`**.

**ESCROW-4's owner ruling stands (OD-4-2):** relaying an already-valid CONSENT or ANNUL signature needs no `hasSensitiveAuth` (the consent-key signature is the authority); creating, replacing or moving the consent/signing key needs sensitive re-authentication plus the contract-required wallet authorization.

ESCROW-3A's procedure is how the next rules version is certified for settlement: rebuild the goldens beside the old ones, then add the version to the literal in its own reviewed change.

**ESCROW-3 — overall scope.** The roadmap names the split: 3A covers the money-game hosted prerequisites; 3B covers the Juno backend, signing and durable intents. The sources are:
- Project `claude/GNOLAND1_CHAIN_NEUTRAL_ESCROW_INTERFACE_2026-09-26.md` §23:
  - items 1–9: `record_schema: 2` / `EscrowMoney`, deployment and trust policies, the Juno transport, the KMS signer, `SigningJournal`, `EscrowService`, `variantsDigestV1`, `SetupGame.escrow`, and tests;
  - obligations O-1…O-10.
- The 11 ESCROW-3 prerequisites in LIVE-2F/3D §14.
- RUST-RETIRE 2B.4, the config/env rename (`REACT_APP_CONTRACT_ADDRESS`) and the cw2 contract-name check (Project `claude/RUST_RETIREMENT_AUDIT_2026-09-26.md` §10).
- Do not confuse ESCROW-3A/3B with `MIGRATION_PLAN.md`'s lowercase "3a/3b/3c" (legacy, archived), or with "ESCROW-3c" (forfeit/clemency weights, still `REASON_NOT_SUPPORTED`).

**Also note.** "Junox E2E" is called "ESCROW-5" in older docs. The Rust-retirement plan (`claude/RUST_RETIREMENT_AUDIT_2026-09-26.md`) is partly stale:
- the optimizer pin is now settled by ESCROW-B2;
- 2A is done;
- 2B.3 was done in LIVE-2D.

---

## C. Canonical documents — READ THESE

### C.1 In the repository

| Document | What it is |
|---|---|
| `PROJECT_CANONICAL_CONTEXT.md` | This file |
| `ROADMAP_3_2_REMAINING_WORK.md` | **The canonical roadmap:** phases, status, estimates and scope sources |
| `RULES_HARDENING_BACKLOG.md` | The living ledger. Read it by section, never whole. Part B: open rules items. **Part C: the one UI/UX backlog (U-items).** Part D: owner decisions (D-n). Part E: the replay/version ledger |
| `VARIANT_CERT_DELAYED_AUCTION_AUDIT_2026-09-25.md` | The current Delayed Auction audit, at revision 11 (the DA closure record in the repo) |
| `VISUAL_FLOURISH_BACKLOG.md` | The visual-polish backlog. Only for the UX backlog/polish phase |
| `contracts/escrow/README.md`, `contracts/escrow/gasbench/README.md` | The escrow contract and its gas harness |
| `LIVE4_COMPATIBILITY_MODEL.md` | **LIVE-4's compatibility model:** the four identities (rules, hosted, financial, client), the two directions of compatibility, the operator surfaces (banner, `ops/status.json`, `gamesDoctor compat` / `continuation`), the newer-format log runbook, the LIVE-5 edge requirement and the `/gs/api/*` decision |
| `PLAYTEST_TRANSPORT.md`, `PLAYTEST_NGROK.md`, `start-playtest.ps1` | Runbooks for hosted playtests (build ids are diagnostic for current browsers; LIVE-4) |
| `archive/claude-history/PROJECT_DOCS_MANIFEST.md` | Classifies every Project doc as current, reference or historical |
| `1830 FULL RULES with variants.pdf` | The rulebook. Rulebook authority is described in the backlog header |

### C.2 In the Project (`claude/…`): current truth

| Topic | Document |
|---|---|
| LIVE-5 L5-5: the signing ledger (slot, fences, schema, settle rules), the KMS binding and its failure classes, configuration v3, the review and mutation evidence, the L5-6/L5-7 handoffs | `claude/LIVE5_L5_5_SIGNING_KMS_2026-09-29.md` |
| LIVE-5 L5-4: identity on DynamoDB (schema, conditions, the fence and marker, chunking, the security-event journal and grants, the conformance and mutation evidence, the review, the L5-7 / L5-8 / L6-4 handoffs) | `claude/LIVE5_L5_4_IDENTITY_2026-09-29.md` (the design summary: `server/src/aws/README.md` §5) |
| LIVE-5 L5-2: the DynamoDB game-table adapters (schema and keys, the fence inside every write, the resend engine and settlement, size guards, the ownership primitives, the conformance matrix, the review and its mutations, the L5-3/L5-6/L5-7 handoffs) | `claude/LIVE5_L5_2_DYNAMO_GAME_STORES_2026-09-29.md` (the convention: `server/src/aws/README.md` §4) |
| LIVE-5 L5-1: the persistence conformance foundation (the store-port inventory and its L5-2/4/5 ownership, the conformance matrix, the fault substrate, DynamoDB Local, the AWS client convention, the lockfile repair) | `claude/LIVE5_L5_1_CONFORMANCE_2026-09-29.md` (the convention itself: `server/src/aws/README.md`) |
| LIVE-4 L4-7: the final certification (the race boundary, the durable-conflict restart rule, the matrices, the gate, the mutation campaign, the review, the LIVE-5 handoffs) | `claude/LIVE4_L4_7_FINAL_CERTIFICATION_2026-09-29.md` |
| LIVE-4 L4-6: tooling, diagnostics, runbooks and canonical docs | `claude/LIVE4_L4_6_TOOLING_DOCS_2026-09-29.md` |
| LIVE-4 integration and hardening: the combined tree `6da8a1f`, N-3, the one capability / one runtime merge, the review, the corpus-gate addendum, the L4-7 list (§13) | `claude/LIVE4_INTEGRATION_HARDENING_2026-09-28.md` |
| LIVE-4 slices: L4-1 canonical model; L4-2 no-money continuation; L4-3 client compatibility; L4-4 money continuation; L4-5 crypto seed | `claude/LIVE4_L4_1_CANONICAL_MODEL_2026-09-28.md`, `claude/LIVE4_L4_2_NO_MONEY_CONTINUATION_2026-09-28.md`, `claude/LIVE4_L4_3_CLIENT_COMPATIBILITY_2026-09-28.md`, `claude/LIVE4_L4_4_MONEY_CONTINUATION_2026-09-28.md`, `claude/LIVE4_L4_5_CRYPTO_RNG_2026-09-28.md` |
| Route engine: extraction / certification preflight (the separate gameplay program; S6-15 / S6-16) | `claude/ROUTE_ENGINE_EXTRACTION_CERTIFICATION_PREFLIGHT_2026-09-28.md` |
| Route v12 R12-1: the independent oracle, its law model, the known-red fixtures, the corpus comparison, the owner rulings applied by the repair (IL-2/3/4/11, warehouses, #62 at $80), the closure's board data (Montreal 40/60 and Norfolk 30/50, each one city with two slots) and the R12-2 handoff | `claude/ROUTE_V12_R12_1_ORACLE_2026-09-29.md` |
| ESCROW-4: the player-facing Juno escrow path (wallet proof, admission wiring, W-13, R-J1, funding, Start, consent keys, relays, settlement UX); §20 LIVE-4 compatibility handoff; §19 LIVE-5/Junox handoff | `claude/ESCROW4_KEPLR_WALLET_CONSENT_2026-09-28.md` |
| The integrated gate and closure: ESCROW-4 + 6.5-B + APP-TEST-0A (tested HEAD `467498e`, the totals, the dispute-evidence fix, the closed register) | `claude/INTEGRATED_GATE_ESCROW4_65B_APP0A_2026-09-28.md` + `claude/INTEGRATED_CLOSURE_ESCROW4_65B_APP0A_2026-09-28.md` |
| Phase 6.5, the pre-refactor functional playtest: the preflight (S0 and G1–G5, the checklist), the corrected register, the fix-before pass | `claude/PHASE6_5_FUNCTIONAL_PLAYTEST_PREFLIGHT_2026-09-28.md`, `claude/PHASE6_5A_CORRECTIONS_H01_2026-09-28.md`, `claude/PHASE6_5B_FIX_BEFORE_2026-09-28.md` |
| APP-TEST-0A (the shell source-scan guards) and the App.tsx decomposition audit (Phase 7's input) | `claude/APP_TEST_0A_SOURCE_GUARDS_2026-09-28.md`, `claude/APP_TSX_DECOMPOSITION_AUDIT_2026-09-28.md` |
| LIVE-4 compatibility / continuation preflight (the next pass's design) | `claude/LIVE4_COMPATIBILITY_CONTINUATION_PREFLIGHT_2026-09-28.md` |
| ESCROW-JOIN: the contract's Join admission, escrow 2.0.0, the canonical wasm `5ecc3022…`, `authorizeJoin` | `claude/ESCROW_JOIN_ADMISSION_SECURITY_REPAIR_2026-09-28.md` |
| ESCROW-3B: Juno backend, durable intents, reversible freeze (§18 junk-Join: historical, closed by ESCROW-JOIN) | `claude/ESCROW3B_JUNO_BACKEND_2026-09-27.md` |
| ESCROW-4 preflight (the design ESCROW-4 implemented; the ESCROW-4 report is what landed; its W-1/OD-4-8 are superseded) | `claude/ESCROW4_PREFLIGHT_KEPLR_WALLET_CONSENT_2026-09-27.md` |
| ESCROW-3A: v11 settlement + money-game prerequisites | `claude/ESCROW3A_MONEY_GAME_PREREQUISITES_2026-09-27.md` |
| DA-8 / v11 closure | `claude/DA8_RULES_V11_CLOSURE_2026-09-27.md` |
| Hosted-authority certification (LIVE-2F / 3D) | `claude/LIVE2F_LIVE3D_HOSTED_AUTHORITY_CERTIFICATION_2026-09-27.md` |
| Restore / reconciliation / lifecycle (LIVE-3C) | `claude/live3c-restore-reconciliation-lifecycle-2026-09-27.md` |
| Profiles and identity (LIVE-2E) | `claude/live2e-mandatory-profiles-2026-09-26.md` |
| What landed, with the commit↔patch map (INTEGRATION-1) | `claude/INTEGRATION1_CERTIFIED_PATCH_COLLAPSE_2026-09-26.md` |
| Settlement spec — valuation (SET-0A rev 2, v10; rerun for v11 in ESCROW-3A §2) | `claude/SET0A_NET_WORTH_VALUATION_AUDIT_2026-09-25.md` + `claude/SET0A_golden_vectors_2026-09-25.json` |
| Settlement spec — primitives (SET-0B) | `claude/SET0B_SETTLEMENT_PRIMITIVES_2026-09-25.md` |
| Settlement spec — cross-language conformance (SET-0C) | `claude/SET0C_CROSS_LANGUAGE_CONFORMANCE_2026-09-26.md` (§20 supersedes its earlier sections; §17's pin policy is amended by DA-8) |
| Escrow canonical record (artifact gate) | the procedure: `claude/ESCROW_B2_CANONICAL_ARTIFACT_GATE_2026-09-26.md` + `claude/ESCROW_B2.1_OPTIMIZER_RUST181_COMPAT_2026-09-26.md`; the current artifact (2.0.0) and its gas table: `claude/ESCROW_JOIN_ADMISSION_SECURITY_REPAIR_2026-09-28.md` §10–11 + `claude/ESCROW_JOIN_canonical_gas_table_5ecc3022.md` |
| Chain-neutral interface (GNOLAND-1) | `claude/GNOLAND1_CHAIN_NEUTRAL_ESCROW_INTERFACE_2026-09-26.md` (§§3, 10–15, 19–23, 26; **§11 step 3 amended by ESCROW-JOIN**: every backend's Join carries the server's admission — `EscrowCodec.joinAdmissionDigest`, capability `joinAuthorization: "server-admission"`) |
| GNOLAND-1.1 baseline and regression | `claude/GNOLAND1.1_CANONICAL_ESCROW_0006_REGRESSION_2026-09-26.md` |
| Rust-retirement plan and evidence | `claude/RUST_RETIREMENT_AUDIT_2026-09-26.md` (partly stale; see §B) |

**Reference only.** Open these only when a current document points to them:
- `ESCROW_LIVE_RECONCILIATION_2026-09-25.md` (ESCROW-1.5, amended A1–A3: the spec baseline);
- `ESCROW2.1_CORRECTIVE_PASS_2026-09-25.md` and `ESCROW2.2_COMPROMISED_SETTLEMENT_CLOSURE_2026-09-26.md` (trusted_seq, `CompromisedSettlement`);
- `ESCROW_B2_canonical_gas_table_b263277a.md` and `ESCROW_B2_run-b2.ps1` (B2 evidence kit; not in git by design);
- `LIVE2_IDENTITY_ROOM_AUTHORITY_DESIGN_2026-09-25.md` (authz matrix §6, RV rules);
- `LIVE3_COMMIT_PERSISTENCE_RECOVERY_DESIGN_2026-09-25.md` (§15 DynamoDB, §19 escrow seam, §20.3, FI-1…29, §24.2 vocabulary);
- `LIVE_MULTIPLAYER_AWS_ARCHITECTURE_AUDIT_2026-09-25.md` (§25 only);
- `live2d-client-cutover-2026-09-26.md` (cited by `start-playtest.ps1`);
- `GNOLAND0_ESCROW_FEASIBILITY_2026-09-26.md` (only when Gno resumes);
- `rules-reference-layout.md` (UX phase).

Every other Project report is **historical**; see the manifest.

### C.3 LIVE-4 reading order

**For LIVE-5 (LIVE-4 is closed):** this file; `LIVE4_COMPATIBILITY_MODEL.md` (§4: the edge requirement and the
`/gs/api/*` decision); the L4-7 report's LIVE-5 handoffs; then ESCROW-4 §19. From L5-2 on, also: the L5-1 report
(its §3 inventory and §11 handoff), `server/src/aws/README.md`, and the LIVE-5/6 architecture preflight (§3–§5, §22). From L5-3 on, also the L5-2 report's handoff section. For L5-7, L5-8 and L6-4, also: the L5-4 report's handoffs. The LIVE-4 slice, integration and L4-6
reports are needed only where a LIVE-5 question reaches back into them. The list below is the order LIVE-4 started
from, kept for provenance.

1. This file, then `ROADMAP_3_2_REMAINING_WORK.md` (Phase 4).
2. `LIVE4_COMPATIBILITY_CONTINUATION_PREFLIGHT` (the design).
3. `ESCROW4_KEPLR_WALLET_CONSENT` §20 (the compatibility handoff), §19 (the LIVE-5 handoff) and §17 (residuals).
4. `LIVE_MULTIPLAYER_AWS_ARCHITECTURE_AUDIT` §25 and the LIVE-3 design §15, §20.3, FI-1…29 (the roadmap's Phase 4 sources), only as the LIVE-4 brief needs them.
5. Reference, only when a step needs it: `ESCROW3B_JUNO_BACKEND` §14 and §21; `ESCROW_JOIN_ADMISSION_SECURITY_REPAIR` §17; `ESCROW3A_MONEY_GAME_PREREQUISITES` §9–11.

---

## D. Frozen invariants (do not change without the owner's explicit, separately reviewed pass)

**1. Gameplay rules are v11**
- Any change to what a stored log replays to must bump `RULES_ENGINE_VERSION` and add a changelog row.
- Logs are never repinned or rewritten. A game runs only under its deal's pin.

**2. Settlement is certified for v10 and v11** (`[10, 11]`, an explicit literal; see §A). A later version is added only by its own certification pass. v10 and v11 evidence is never regenerated.

**3. The canonical Juno escrow wasm** is `eighteen_cosmos_escrow.wasm`, **escrow 2.0.0** (ESCROW-JOIN, the Join admission):
- **SHA-256 `5ecc302221a2dab4bb4f0f71b632f2beeafe9523ebd7b33bd0e94d017b8d09e8`**, 534,085 B.
- It is not in git. The owner's copy is at `C:\escrow-join-b2\out\canonical\` (and `target\escrow-join-kit\out\canonical\`).
- Built from the kit commit `711e5c1` (on `5298d95`), whose contract inputs — `contracts/escrow/src` tree `96445b72…`, `contracts/escrow/Cargo.toml`, `Cargo.lock`, the workspace `Cargo.toml` — are exactly the ESCROW-JOIN commit's.
- Built with `cosmwasm/optimizer:0.16.1@sha256:b9c92b2900b7ebaab3499203615c1b8589592bc557355ed3432e48851ffde69e` and rustc/cargo 1.81.0; two fresh-volume builds byte-identical; max 68 locals; `cosmwasm-check` 1.5.11 / 2.2.9 / 3.0.5 / 3.0.9 pass.
- **Historical, never for money:** escrow 1.0.0, `b263277aa5d1d63c33e8e238f27ad2b9ee4749c9a66abe82ef3146d51d119296` (526,033 B, ESCROW-B2, from `86b7356` = `6796123`): its Join seated any payer. The server's configuration refuses it by name; a 1.0.0 instance is replaced, never migrated.
- Rust pins:
  - `contracts/escrow/Cargo.toml` has `rust-version = "1.81"`;
  - `Cargo.lock` pins `base64ct 1.7.3` and `zeroize 1.8.2`. **Never `cargo update` these.**
  - `cosmwasm-std` is 1.5.11.

**4. Settlement bytes are frozen.** They are never regenerated or repinned, and v11 goldens go *beside* them. A change is a certified-byte change and needs its own certification pass.

| File | SHA-256 |
|---|---|
| `contracts/escrow/testdata/payload_vectors_v1.json` | `635024311cb76a2b808a46f31285721c865effbed4ff0eed172a85487d1958ac` |
| `frontend/src/utils/__fixtures__/settlement/settlementPayloadVectorsV1.json` | `b58651de13de2c4f91d355c15cca92689001ba4bcbdb2a9fbaa348cbe6a7906c` |
| `contracts/escrow/testdata/set0a_payout_vectors_rev2.json` | `dfe9fbdfa8f88c21bd5cc8eeecbd06f0ef7db4ce6ba8bf72aa4633b7a39d4994` |
| `frontend/src/utils/__fixtures__/settlement/SET0A_golden_vectors_rev2.derived.json` | `c16fb8170d38a6b6870d0e39091337d82d89fc2a54bb29f41b98cc98a5c7721a` |
| `frontend/src/utils/__fixtures__/settlement/settlementCrossLanguageVectors.json` | `50bf34e1374767df4e3273198cfe6537ba7f73fefd51d9a437b0f113c3015d74` |

- Also frozen: the `contracts/escrow/schema/` tree (regenerated once for escrow 2.0.0 by ESCROW-JOIN: tree `8ddb532d…`), and `.gitattributes` `eol=lf` on these paths.
- Also frozen (ESCROW-JOIN, not a settlement byte): `contracts/escrow/testdata/join_admission_vectors_v1.json`, SHA-256 `cacc9ea3d0086253e27d8a67b7c16266f7113799526e888fe810197d16763cfb`.
- Guarded by the oracle `frontend/src/utils/escrowJunoRegressionOracle.test.ts`, which must stay green.

**5. TypeScript is the gameplay authority.** No chain response can rewrite gameplay state. `SetupGame.escrow` is declared and ignored by the reducer, so it needs no rules bump.

**5a. The money path's trust boundary (ESCROW-4).**
- The browser signs only wallet messages it builds itself from its build's pinned deployment and neutral fields; it never signs server-supplied bytes or execute JSON. The server never signs a player's wallet message: it signs only its relayer transactions (carrying the players' own CONSENT/ANNUL signatures) and the Join admission.
- "Funded" is only ever the chain's (read by quorum when two or more endpoints are configured). A tx hash from a browser is a hint; the browser's own pending record never says "funded".
- A seat is never reassigned. A deposit whose link ended is relinked (the same wallet, a fresh proof) or withdrawn; `leave` is only an unsubscribe.
- Versions: `FINANCIAL_PROTOCOL_VERSION` 3; money GameRecords `record_schema: 2`, no-money records 1; the hosted protocol 1. A protocol-2 grant file is refused, never reinterpreted.

**5b. Compatibility is semantic, never a build (LIVE-4).**
- Whether a process continues a stored game is `continuationVerdict` over the game's semantic identity (rules pin, hosted protocol, money identity, deployment) against the process's one capability; whether a protocol-1 client may play is `clientVerdict` over its announced protocol and rules. **Neither reads a build id**, and the compatibility key contains none. Only the legacy protocol-0 wire keeps its exact build compare, until it is retired.
- A derived "not continued" is written nowhere; only the owning pool writes a conflict's hold. A **deployment** conflict is concluded only from a verification-grade chain read, and its hold (`binding-mismatch`) is written at once and over any weaker hold; it outlives the process: a run that has not read the deployment's chain facts does not continue the game, and its release needs an agreeing read (L4-7). The other conflicts (identity, the missing record's placeholder) come from durable facts and keep "the first hold stands". Operator inspection writes nothing.
- The edge in front of the game server must forward `/gs*` query strings unchanged (`cp`, `cr`, `cb`), or current clients read as legacy ones (LIVE-5).
- The description: `LIVE4_COMPATIBILITY_MODEL.md`.

**6. The blockchain is escrow only:** a vault, a notary and a settlement calculator.

**7. Authority chain:** authenticated profile → principal → durable GameRecord seat → `player_id` → serialized GameActor → append-only committed log → pinned TypeScript rules engine.
- A frame never names an actor. `seatOf(record, principal)` runs inside the actor task.
- `game_id` is the server's `g_…`. `chain_game_id` is the contract's u64. `player_id` (`p-…`) is the same in money and no-money games.
- `pr_`/`pf_`/`se_`/`sf_`/`rk_` ids never go on the wire or on chain. `sf_` session families (ESCROW-3A) are not an identity: they only group one browser's rotation lineage.

**8. No seat rebind.** There is no seat copy, transfer or reassignment primitive. `binding_epoch` is carried and never moved. Recovery restores the same principal.

**9. One-step undo.** Only the most recent action can be undone (`revertRefusal`, `logRevert.ts`). Money rooms use `host_undo: "none"`.

**10. Settlement arithmetic and seam**
- Payout = `floor(pool·w_i/Σw)` with a Uint256 intermediate; dust goes to the treasury.
- Weights are whole-VGP u128 in `chain_seat_index` order. No principal or player id appears in any payload byte.
- `SettlementLifecycle.onGameplayClosed` is at-least-once. ESCROW-3A's coordinator (`server/src/escrow/settlementCoordinator.ts`) makes it idempotent by `(gameId, seal.log_len)`. Settlement derives only from `sealedPrefix(entries, seal)`, which is `log[0..seal.log_len)`.
- A dealt money game is never cancelled, refunded or abandoned by the server (`moneyLifecycle.ts`). It ends by play, by unanimous annul, or by the contract's liveness rule.

**11. Owner-local broad validation.** Claude runs narrow targeted tests only. The owner runs the broad suites and builds locally (§E).

> **Project-instruction drift (known, owner to update).** The claude.ai Project instructions still say two things that ESCROW-1.5 superseded:
> - "fixed-point … scaled to 6 decimal places": settlement weights are **whole-VGP** (ESCROW-1.5 §5.1);
> - the fee comes "from game lobby creation deposits": the contract takes its bps cut on **every** deposit (§14 row 14).
>
> Follow the current records.

---

## E. Standing workflow

- **The owner leads.** The owner rules, sets scope and advances `origin/main`. Claude implements and investigates.
- **One writer in the real checkout** (`C:\Users\Bradshaw\Documents\GitHub\1830Juno`). Concurrent work happens only in isolated clones or branches.
- **Do not push** unless the owner says so.
- **Stop at the phase hard-stop** named in the brief.
- **Claude runs only narrow, targeted tests** (single files or small batches, never in parallel). **Claude never runs full Jest.** The owner runs the broad suites, builds, server tests and smoke locally.
- **Broad gates are owner-machine work (owner rule, 2026-09-29, set during L4-7):** "Claude must not run broad/full test suites when the owner's Windows development machine can run them cheaply. Claude should use targeted tests during implementation only when necessary. Broad Jest suites, broad server suites, production builds, corpus gates and equivalent owner gates are owner-machine work, not Claude-cloud work, unless the owner explicitly requests otherwise." An owner instruction to stop testing takes effect at once, over any brief's gate list.
- **End each pass with exact PowerShell owner-validation commands.** Template:

```powershell
cd C:\Users\Bradshaw\Documents\GitHub\1830Juno\frontend
$env:CI = "true"
npx react-app-rewired test --watchAll=false <changed test files>   # targeted
npm run typecheck
npm run build
powershell -ExecutionPolicy Bypass -File .\test-summary.ps1         # broad gate (owner only)
cd ..\server
npm run build; npm test; npm run smoke
npm run gamesDoctor -- scan-v10
```

**Device notes (a Linux VM over the Windows checkout)**
- Use `GIT_OPTIONAL_LOCKS=0` / `--no-optional-locks` for read-only git.
- A stale `.git/index.lock` is removed only after delete permission has been granted.
- Each call has a 180 s limit, so the production build is an owner gate.
- The untracked `.claude/` directory is expected.
- About 265 `.git/objects/tmp_obj_*` files are left for owner-run git maintenance. Do not delete them by hand.

**Reports**
- Each pass writes one concise report to the Project as `claude/<PASS>_<DATE>.md`.
- Update `RULES_HARDENING_BACKLOG.md` when rules items change.
- Update this file when the current state, the canonical set or the invariants change.
- Update `ROADMAP_3_2_REMAINING_WORK.md` when a phase closes, is re-scoped or is re-estimated.

---

## F. Where historical material lives

> Older design/certification history is archived and should be consulted only when a current canonical document points
> to it or a historical/provenance question requires it.

- **`archive/`** (repository): superseded root documents, filenames unchanged. `archive/README.md` maps each one.
  - `claude-history/`: the Batch 1–7.5 reports and the VF-2 visual prototypes;
  - `certification-history/`: the `AUDIT_*` files, the Stage 9 audit, and the Gentle Rust / Unpredictable Revenue certifications;
  - `design-history/`: the Stage 8 design, `DECISIONS_2026-09-06`, the original seed specs, `TECH_DEBT`;
  - `migration-history/`: `MIGRATION_PLAN.md`.

  Code comments that name these files by bare filename still resolve there.
- **`docs/ai_architecture/`**: the numbered design-note archive (`<file> #N`). Source comments cite it by path, so it stays in place. Consult an entry only when a code comment points to it.
- **Project historical reports**: every Project doc not listed in §C.2 (see the manifest). They will move into `archive/claude-history/` from a claude.ai data export in a later pass.
- **Git history**: the patch series and every earlier revision. `git log --follow <file>` works across the archive moves.
