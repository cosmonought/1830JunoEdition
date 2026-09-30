# AWS clients, DynamoDB Local, the game table, identity, ownership, the relayer role and the AWS runtime — the LIVE-5 convention

LIVE-5 L5-1 set this up so that every later LIVE-5 slice uses one convention. L5-2 (the game table), L5-4 (identity),
L5-5 (the ledger and KMS) and L5-7 (the AWS wiring, §8) all follow it; none of them should pick its own.

## 1. Creating a client: `awsClients.ts`, and nowhere else

A client is created only by `createDynamoDbClient(target)`, (L5-5) `createKmsClient(target)`, or (L5-7) `createSsmClient` /
`createSecretsManagerClient`, or by the matching factory a later slice adds to this same file. The test `awsClients.test.ts` scans `server/src` (ES imports, `require` and dynamic
`import`) and enforces:

- no other source file constructs a DynamoDB client (`DynamoDBClient` or the aggregated `DynamoDB`) or a KMS client
  (`KMSClient` or the aggregated `KMS`);
- nothing uses the document client: it marshals values, and stored bytes must be exact;
- only `@aws-sdk/client-dynamodb` and `@aws-sdk/client-kms` are imported, plus (L5-7) `@aws-sdk/client-ssm` and
  `@aws-sdk/client-secrets-manager` in `awsClients.ts` and `runtime/configSource.ts` only (all four pinned exactly at
  3.1142.0), and nothing reaches into `@smithy/*`;
- (L5-7) the AWS adapters are reached only through the runtime composition, `aws/runtime/` (§8, "The import boundary");
- no file outside `persistence/conformance/` imports the conformance harness or its proof adapter.

| Concern | Rule |
|---|---|
| **Target** | Always explicit. `{ kind: "dynamodb-local", endpoint }` is for tests and development. `{ kind: "aws", region }` is for real AWS (L5-7 wires it: the regions come from the runtime document and the ARNs, §8). |
| **Endpoint override** | Only for DynamoDB Local, and only a plain `http://` loopback endpoint (`localhost`, `127.0.0.1` or `[::1]`) with an explicit port and no path, query or credentials (`localEndpointProblem`). An `aws` client sets `ignoreConfiguredEndpointUrls`, so `AWS_ENDPOINT_URL*` and profile endpoint settings cannot redirect it. |
| **Region** | Local: the fake region `gs-local`, which is not an AWS region. AWS: an explicit, validated region. The region is never taken from the environment or instance metadata. |
| **Shared config file** | Both targets pin every setting a profile line or environment variable could otherwise change (`PINNED_CLIENT_SETTINGS`): no configured endpoint URL, no FIPS or dual-stack endpoint, and the standard retry mode, never the adaptive rate limiter. The test runs under a hostile `AWS_CONFIG_FILE` and environment. |
| **Credentials** | Local: fixed alphanumeric dummy keys (`gslocaltest`). DynamoDB Local refuses other characters. Because the keys are fixed, the default credential chain is never consulted: no profile credentials, environment keys or metadata endpoint are used. AWS: the SDK default chain, which on ECS is the task role. Secrets never go in environment variables (preflight §11.6). |
| **Retries** | Off in the SDK (`maxAttempts: 1`). An authoritative write is resent only by its adapter, with the **same** `ClientRequestToken`. A conditional failure on a resend is settled by a strong read (preflight D-3, §4). A generic SDK retry would sign a new request and could turn one write into two. |
| **Timeouts** | Connect 2 s. Request 5 s, the actor's E-11 store deadline. `throwOnRequestTimeout: true` is required: without it the SDK only logs a timeout. An adapter treats a timeout as an **unknown** outcome, never as a failure. |
| **Abort** | Every call passes `{ abortSignal: deadline() }`, which bounds the whole call (default 8 s). |
| **Services** | DynamoDB, (L5-5) KMS, and (L5-7) SSM Parameter Store and Secrets Manager -- AWS targets only (the tests fake the ports above them), the same pinned settings, SDK retries off, bounded throwing timeouts. |

**KMS (L5-5).** `createKmsClient({ kind: "aws", region })` for AWS, `{ kind: "kms-local", endpoint }` only for the tests'
KMS stand-in (loopback http, the fake region, the dummy keys, exactly as DynamoDB Local). Same pinned settings, SDK retries
off; tighter bounds: connect 2 s, request **3 s** (preflight §11.2), a 4 s call deadline. The client is used only through
`kms/kmsDigestClient.ts`, the signer seam's `KmsClient`:

- a key is named by its **key ARN** in the client's own region -- never an alias (it can be repointed), a bare key id or
  another region; anything else is refused before a request is sent;
- `Sign` is sent exactly the caller's 32 bytes with `MessageType=DIGEST` and `SigningAlgorithm=ECDSA_SHA_256`, nothing
  else; every answer must name the requested key and algorithm (`GetPublicKey`: `ECC_SECG_P256K1`, `SIGN_VERIFY`);
- every failure is one explicit class (`transient` / `refused` / `invalid-answer`, plus whether a signature may exist
  in a lost answer), which `signer.ts` maps to `unavailable` / `refused` / `verify-failed`; the signature is then
  verified against the key's public key before use. No failure tries another key, region or signer.

**The signing ledger (L5-5)** is `ledger/dynamoSigningLedger.ts`: the `SigningJournal` port over one table (the preflight's
ledger account). It is a `dynamodb` subject of `JOURNAL_CASES` (`persistence/conformance/dynamoLedger.conformance.test.ts`,
run by `npm run test:dynamodb-local`). Its model -- the slot, the two fences, the item shapes, how an unknown outcome is
settled -- is written at the top of that file.

## 2. DynamoDB Local for the suites

`npm test` never needs DynamoDB. The DynamoDB suites run under their own script. They connect only to the endpoint
named in `GS_DYNAMODB_LOCAL_ENDPOINT`, which must be a loopback http endpoint. If the variable is missing, the suite
fails with instructions; it does not skip.

**Start DynamoDB Local (pick one):**

```powershell
# Docker, version pinned (3.3.1; manifest list sha256:ff89bd48ff32cd8d9be5fee8873b65b8854dc408f1afe881be6eb00247bc0dab)
docker run --rm -p 127.0.0.1:8000:8000 amazon/dynamodb-local:3.3.1 -jar DynamoDBLocal.jar -inMemory

# Java 17+, no Docker. The tarball behind this URL moves, so check the startup banner says "Version: 3.3.1".
# L5-1 ran with the tarball SHA-256 f80bcec477f85f57e2c77f8d54aa6b672a8403fceff0c450560aee1cf6c21163.
#   https://d1ni2b6xgvw0s0.cloudfront.net/v2.x/dynamodb_local_latest.tar.gz  (extract it, then:)
java "-Djava.library.path=./DynamoDBLocal_lib" -jar DynamoDBLocal.jar -inMemory -port 8000
```

**Run the suite:**

```powershell
cd C:\Users\Bradshaw\Documents\GitHub\1830Juno\server
npm run build
$env:GS_DYNAMODB_LOCAL_ENDPOINT = "http://127.0.0.1:8000"
npm run test:dynamodb-local
Remove-Item Env:GS_DYNAMODB_LOCAL_ENDPOINT
```

**What the substrate guarantees** (`persistence/conformance/dynamoLocal.ts`):

| Guarantee | How |
|---|---|
| Isolation | One table per case, named `gs-l5conf-<run>-<n>-<label>`. `<run>` is random per process. |
| Cleanup | Each case drops its own table. At the end, `dropAll` deletes exactly the tables that run created: never a listing, never a pattern. The suite checks that none of its tables remain. |
| Local only | `requireLocal` refuses any client without an explicit loopback endpoint, the fake region and the dummy keys. |
| No polling | Creating a table checks once that it is ACTIVE. |
| Faults | `installFaults(client, script)` applies the same deterministic `FaultScript` the file seam uses, per command: `fail` (throttled, nothing sent), `lose-answer` (applied, then a timeout), `stall` (held at a gate) and `duplicate`. |

## 3. What the conformance harness expects of a new adapter (L5-2, L5-4, L5-5)

Add the adapter as a **subject** (`backend: "dynamodb"`) of its port's existing cases, in
`persistence/conformance/*.conformance.ts`. Do not write new private tests that restate the port.

- Declare the capabilities the adapter really has, and implement each one's hook (the runner refuses a declared capability without its hook).
- A `dynamodb` subject **must** declare `REQUIRED_CAPABILITIES.dynamodb`. These are durable, fence, **fence-in-write**, plant, stall-write, **idempotency-token**, inject-lost-answer and inject-transient-failure. Anything missing needs a reasoned `exemptions` entry, or the suite refuses to register.
- Put any intentional difference in `differences`, with a reason, where review can see it.

Every port has a "fence inside the write" case: a takeover landing between the writer's own checks and the write must
still refuse the write. The cases are LOG-20, REC-18, HOLD-12, FIN-11, INT-12, TKT-11, ID-14 and JNL-12 (and, from L5-5,
JNL-16 for the journal's attempts), and L5-4's ID-20-takeover-during-step. The file stores fail them, because they
check their fence before writing (F-L5-4).
`fenceGap.test.ts` pins that per port, which also proves each case detects a check-then-write store. L5-4's two new ports
have theirs too (GRANT-08, SEC-06); they have no file store, so only their DynamoDB subjects run them and nothing is
pinned.

The one DynamoDB adapter in L5-1, `dynamoProofFinancialStore.ts`, is a **proof only**, for the harness. It is not
production code and not the L5-2 design.
The production adapters are L5-2's game table (§4), L5-4's identity (§5) and L5-5's signing ledger
(`ledger/dynamoSigningLedger.ts`, §1).

**Tokens are global.** A `ClientRequestToken` is remembered by DynamoDB (and by a DynamoDB Local process) for ten minutes
across every table of the account: a test that fixes a token must make it unique per run, or a second run meets the
first run's request (`IdempotentParameterMismatch`). Adapters draw a random UUID per logical write.

L5-2 added two capabilities every `dynamodb` subject must also declare: **`cas-in-write`** (a write's own condition --
create-if-absent, the version CAS, the log's next index -- is evaluated inside the write; race cases LOG-28, REC-21,
HOLD-16, FIN-19, INT-16, TKT-14) and **`inject-unevaluated`** (hook `armUnevaluated`: every resend fails unevaluated, reads
work; a visible write is committed, an invisible one UNCERTAIN). Each game-table port also has a second fence-inside-the-
write case (LOG-25 chat, REC-19 join code, HOLD-13 release, FIN-16 create, INT-13 create, TKT-12 first ledger). The file
stores fail every one of these for the right reason; `fenceGap.test.ts` pins it.
L5-5's signing ledger (integrated after L5-2) declares `cas-in-write`; it exempts `inject-unevaluated`, which no journal
case uses (its own unevaluated-resend case pins the behaviour).

## 4. The game table (LIVE-5 L5-2): `aws/game/`

Six adapters behind today's ports, over ONE table (`pk`/`sk` strings, no secondary index): `createDynamoLogStore`,
`createDynamoRecordStore`, `createDynamoHoldStore`, `createDynamoFinancialStore`, `createDynamoIntentStore`,
`createDynamoTicketStore`. **Wired by L5-7** (§8): only the ownership layer and the runtime composition (`aws/runtime/`)
may import them (`awsClients.test.ts`).

| Rule | Where |
|---|---|
| Keys: `GAME#<g>` / `HEAD`, `META`, `LOG#%010d`, `CHAT#…`, `HOLD`, `HOLDREL#…`, `FIN`, `TICKETS`, `INTENT#<id>`; `POOL#<p>`, `JOIN#<code>`, `DIR#<yyyymm>` + `DIRKEYS`, `FINIDX#<identity>` + `FINKEYS`, `RELAYQ#<queue>`, `LIST#<kind>` | `gameTable.ts` header |
| **The fence is inside the write.** Every game write carries `ConditionCheck HEAD: owner_pool = :P AND pool_epoch = :E` (merged into the HEAD update for a log batch); a write that makes a game or names none (record and money-game birth, join codes, `claimGame`) carries `POOL#<p> writer_epoch = :E` | `gameFence`, `poolFence`, `headCreateOrMine` |
| **One token per logical write.** One `TransactWriteItems` with a `ClientRequestToken`; an unknown outcome is resent with the SAME token (TransactionInProgress waits) until DynamoDB evaluates it, within 8 minutes (a longer window is refused); a first-attempt transaction conflict is retried 3 times with the same token | `transact.ts` |
| **Settling a lost answer.** Every item carries the write's token (`att`, recent `atts`). Fence read on its own, then the target set as ONE snapshot (`TransactGetItems` for several items). Token there: committed. Absent and a resend was evaluated and refused: definite. Otherwise **uncertain -- the write may still land later** | `storeSupport.ts` |
| **Never overwrite what was not read.** Every replace/delete names the exact item read (`att`, or its whole body when it has no token); a create is `attribute_not_exists`; unreadable, newer and older artifacts are refused before any write | `observedCondition` |
| **Sizes.** Item ≤ 350 KiB, transaction ≤ 3.5 MiB and ≤ 80 actions, checked BEFORE sending (definite); a log batch is ≤ 78 entries (≥ the 65 the server builds) | `SIZE_POLICY`, `DYNAMO_LOG_MAX_BATCH` |
| **Log bytes.** Each `LOG#` item holds the file store's exact line; the load runs `scanLog` over them and checks HEAD and positions (a torn tail is damage here); the export is byte-identical to a file log | `dynamoLogStore.ts` |
| **Ownership primitives for L5-3**: `takeOverPool`, `claimGame` (pool-fenced; never creates, never lowers), `releaseGame` | `ownership.ts` |

Run: `npm run test:dynamodb-local` (the L5-1 proof, `dynamoGame.conformance.test.js`, and L5-4's two identity files, §5).

## 5. Identity on DynamoDB (L5-4): `aws/identity/`

| File | What it is |
|---|---|
| `identityItems.ts` | The identity table's items and their strict codec |
| `identityPlan.ts` | Pure: one `IdentityChange` → the TransactWriteItems that carry it, every precondition a condition |
| `dynamoIdentityStore.ts` | The `IdentityStore` for the identity writer, its `grants`, `takeOverIdentityWriter`, the send-and-settle runner |
| `dynamoSecurityJournal.ts` | The `SecurityEventJournal` as `SEC#` items of the ledger table |

**The identity table** (`gs-<env>-identity`; string `pk` / `sk`; no index; PITR on; deletion-protected; **TTL attribute
`ttl`**, which only grant items and commit markers carry):

| pk | sk | Item |
|---|---|---|
| `PRIN#<pr>` · `PROF#<pf>` · `SESS#<se>` · `FAM#<sf>` | `META` | a principal, profile, session (secret only as SHA-256), family |
| `LINK#<sha256>` | `LINK` | a link code (only as SHA-256) |
| `SEL#<rk>` | `SEL` | a recovery selector's **uniqueness item**: its profile, or `retired_at` once rotated away. Never deleted |
| `GRANT#<se>` | `GRANT` | a sensitive-auth grant; TTL `expires_at` + 1 h |
| `ROLE#identity-writer` | `ROLE` | the identity-writer role: `epoch` (ROLE_ID), `task`, `pool`, `taken_at`, `claim` |
| `TXN#<token>` | `TXN` | one transaction's commit marker; TTL 1 day |

Every value is its record's own field, typed (S, canonical-integer N, NULL), every frozen field present, `fmt` = 1.
Nothing else: the `PRIN#/SESS#`-style index items of preflight §3.3 have no reader while the writer loads the whole
table, and are left to the read-through follow-up.

**Every write** is one `TransactWriteItems`: `[ROLE_ID ConditionCheck, the commit marker Put, …the change]`, a fresh
`ClientRequestToken`, SDK retries off. A precondition is a condition of the item it names (merged per item, since one
transaction may not touch an item twice); so is every rule about a record's past and every relation to a record the
change does not carry. Outcomes: committed; **DEFINITE** only when nothing was written (a failed condition, the fence, a
rejection that evaluated nothing); **UNKNOWN** (timeout, network, 5xx) is resent identically and settled by a strong read
of the marker; still unknown → `StoreUncertainError`, the store holds itself and calls `onRestartRequired`. A change over
98 items is split into transactions in a safe order, **every security effect first**: the gate of preconditions,
principals, profiles with their selector items, then families, link codes and the sessions a sign-out ends one by one
(newest first), then every other session write, then dropped sessions. Applied in part it is UNKNOWN and held, and the
prefix loads; a later chunk that is only throttled is retried for about 15 s first.

**The security event's place** (`IdentityCommitOptions.beforeWrite`, the port's one addition): after the pre-check and
the plan the store reads its role strongly, then runs the caller's step (the service appends the `SEC#` event), then
writes. A change the store refuses first leaves no event; a write refused after the event leaves it unconfirmed (the
service appends a `confirmed` event after each committed change). A load also checks the role (a stale epoch is fenced at
once), a takeover writes only a task/pool/time the role codec reads back, and a grant write is one resend, 2 s a call.

**Conformance, with L5-2's rules** (added at integration): the three DynamoDB subjects -- the identity store, its
grants, the security-event journal -- declare L5-2's `inject-unevaluated` (cases ID-21, GRANT-13, SEC-11: visible →
written, invisible → UNKNOWN). The identity store and the journal declare `cas-in-write` (their own conditions are inside
the write); the grants subject exempts it with its reason (a grant write has no condition of its own). No identity-side
race case exercises `cas-in-write` yet: the L5-4 properties (A: 700 random changes judged by the table's conditions
alone) are that evidence. **Wired by L5-7** (§8): like `aws/game`, only the ownership layer, the runtime composition
(`aws/runtime/`) and the conformance suites may import these adapters (`awsClients.test.ts`).

**What L5-7 wired** (§8 has the runtime's exact order):
- take the role (`takeOverIdentityWriter`, with L5-3's `SYSTEM/ROUTING` and `POOL#` checks), then `load` -- never the
  other way round;
- `onFenced` → exit 3 (a stale identity writer must not keep answering from memory, preflight §5.5);
  `onRestartRequired` → the same fail-fast exit as every other store;
- `IdentityService.open(store, { security: { journal, grants: store.grants } })`: the security-event journal on the
  ledger table (`createDynamoSecurityJournal`, with the adopted app generation, or `null` until L6-4 adopts one) and the
  durable grants (OD-5-4);
- on a graceful shutdown, `await identity.settled()` before the process exits: a change's confirmation is appended
  after its answer (round-3 R3-1), and a shutdown should not drop it.

**Owner decisions (2026-09-29):** journal-first stays fail-closed (while the ledger cannot record an event, the security
changes that need one answer unavailable; a recovery stays available); after a restore, an UNCONFIRMED key rotation
retires its old selector, installs nothing and sends the profile to operator review (L6-4, `identity/securityEvents.ts`);
`createFileIdentityStore` stays test-only through LIVE-5.

**L5-8 (IaC)**: the identity table's TTL attribute is `ttl`; the ledger table needs `APPGEN` / `APPGEN`
(`current_generation`) before any generation-fenced append.

## 6. Ownership (L5-3): `aws/ownership/`, `aws/game/routing.ts`, `rooms/gameOwnership.ts`

The layer that turns L5-2's primitives (`takeOverPool`, `claimGame`, `releaseGame`) into who may write what. **Wired by
L5-7** (§8): `awsClients.test.ts` refuses any importer of `aws/ownership` outside itself, the runtime composition
(`aws/runtime/`) and the conformance suites; it is, with the runtime, allowed to import both `aws/game` and `aws/identity`.

| Piece | What it is |
|---|---|
| `aws/game/routing.ts` | `SYSTEM/ROUTING` {`primary_pool`, `routing_version`, `claim`, `fmt` 1}: written only by the pipeline / an operator (`setPrimaryPool`: a strict read, then a CAS on exactly that item; never an `op:` pool). `roleTakeoverChecks(table, fence)` = `[ConditionCheck SYSTEM/ROUTING primary_pool = :P; ConditionCheck POOL#P writer_epoch = :E]` -- the conditions every role takeover carries INSIDE its own transaction |
| `aws/ownership/poolWriter.ts` | `PoolWriter.take` (the pool takeover); the self-check (2 s: `POOL#` epoch and task, each held role's probe, the adopted generation); `onLost` called once when a loss is PROVEN (L5-7: exit 3); a failed or unreadable read is UNKNOWN (never lost, never current: side effects wait, readiness lapses); `beforeSideEffect` (a good check started within 5 s, else one now -- at most two, judged by when the good check started); `readiness` (for `/gs/readyz`) |
| `aws/ownership/roles.ts` | `takeIdentityWriterRole` (routing hint -> L5-4's `takeOverIdentityWriter` with `roleTakeoverChecks` -> a refusal explained from the table: the role item first, then the pool, then the routing); `identityRoleProbe`; `generationProbe` (L5-5's APPGEN via `readAdoptedGeneration`) |
| `aws/ownership/poolGameOwnership.ts` | The rooms layer's `GameOwnership` in POOL mode: claim (claimed / absent / stale-pool -> lost / owned by a newer epoch of this pool -> lost / another pool or `op:` run -> `GameRoutedError` / a malformed HEAD -> damage, never a loss), release, `onFenced` (pool fence -> lost at once; game fence -> a self-check), claims and releases asked in order per game, and `sweepMoneyClaims` |
| `rooms/gameOwnership.ts` | The port, `PROCESS_OWNERSHIP` (today's file/memory behaviour: the lock is the whole fence) and the errors |

**In the rooms layer (only with `GameServerOptions.ownership` in POOL mode; PROCESS mode is unchanged):** the claim is the
actor load's FIRST step (before any read); `absent` loads only a game with no data (a creation makes its HEAD in its first,
pool-fenced write) -- data without a HEAD is refused (`GameWithoutHeadError`); a commit refused by an ownership fence
(`persistence/storeResult.ts` `fenceScopeOf`: the adapters' exact texts) is answered nothing-written, retires the actor
(nothing queued runs), and the actor is dropped: log subscribers get `status unavailable` and a 1012 close; an evicted
idle NO-MONEY game is released; discovery writes nothing (a startup snapshot is never enforced or written: the load
decides after its claim); `retakeResident` drops a QUIESCENT resident actor before the sweep claims its game back.

**What L5-7 wires** (done: §8 has the runtime's exact order), in this order (preflight §13):
1. `PoolWriter.take` (step 4) -- `onLost` -> exit 3; `writer.start()`; `watchGeneration(generationProbe(ledger, table, N))`.
2. Primary only: `takeIdentityWriterRole(writer, identity, …)` -> `createDynamoIdentityStore({ epoch })` -> `load` (L5-4's
   order); `not-primary` -> the non-writer identity path (the IdentityVerifier, later).
3. `createPoolGameOwnership({ client, table, writer, onClaimed: (g) => escrow.service.refreshRoster(g) })` ->
   `createGameServer({ ownership, … })`; every L5-2 adapter constructed with `writer.fence`. Do NOT run
   `escrow.service.preload()` in POOL mode (claim-time `refreshRoster` replaces it; a slower preload could overwrite a
   newer refresh).
4. The money claim sweep at startup and every 60 s: `sweepMoneyClaims({ financial: <the DynamoDB financial store>,
   continues: (r) => moneyContinuationVerdict(r.continuation, THIS_DEPLOYMENT) continues, beforeRetake:
   server.retakeResident, isResident: server.isResident, onSwept: (g) => server.lifecycle.loadGame(g) })` -- BEFORE
   the escrow load, so escrow work only touches games this task owns.
5. `writer.beforeSideEffect()` immediately before every KMS `Sign`, broadcast and join admission (L5-6 for the relayer:
   §7 -- the relayer asks its `RelayerRole`, which asks the pool writer).
6. `/gs/readyz` from `writer.readiness()`.

## 7. The relayer role (L5-6): `aws/game/relayerRole.ts`, `aws/ownership/relayerRole.ts`, the relayer's gates

The relayer is ONE task -- the primary pool's current task -- and it holds TWO fences, both of which every write it makes
carries inside the write:

| Fence | Where | Held as | Carried by |
|---|---|---|---|
| The ledger's relayer fence | ledger `FENCE#relayer#<account>` / `FENCE` (L5-5) | (epoch r, the minting request's token) | every attempt the relayer journals (`recordAttempt`), with `APPGEN` |
| The mirror (ROLE_RL) | game `ROLE#relayer#<account>` / `ROLE` `{fmt 1, epoch r, task, pool, pool_epoch, taken_at, claim}` | (r, the mirror write's `claim`) | every chain-intent write the relayer makes: `createDynamoIntentStore({ ..., relayerRole: role.intentStoreRole() })` puts `ConditionCheck ROLE#relayer#<account>: fmt = 1 AND epoch = :r AND claim = :claim` where the game's HEAD fence would be; that view creates nothing |

**The takeover (`takeRelayerRole(writer, { ledger, now })`), in this order:**
1. the routing, read as a HINT -- not primary: `not-primary`, and NOTHING is minted (a mint fences whoever holds the ledger
   fence);
2. `writer.beforeSideEffect()` -- a stale or paused task mints nothing;
3. the ledger mint (`ledger.takeOverRelayer()`: epoch + 1, compare-and-swap, under `APPGEN`) -- from here every earlier
   holder's attempt writes are refused;
4. the mirror: ONE game-table transaction `[ConditionCheck SYSTEM/ROUTING primary_pool = :P; ConditionCheck POOL#P
   writer_epoch = :E; Put ROLE#relayer COND attribute_not_exists(pk) OR (fmt = 1 AND epoch < :r)]` (L5-3's
   `roleTakeoverChecks`); one token, resent unchanged; a refusal or an unknown answer is explained from the table: the
   mirror carries our claim -> taken; this task's pool moved -> lost (`PoolWriterNotCurrentError`); the routing moved ->
   `not-primary`; a mirror at r or newer -> `RelayerRoleRefusedError`; otherwise `RelayerRoleUnknownError` (it may still
   land; it can never pass a newer mirror) -- never guessed;
5. `writer.holdRole("relayer", probe)`: the probe reads the ledger's `APPGEN` and fence (epoch AND token, through the
   ledger's read-only `relayerFenceHeld()`) and the mirror (epoch AND claim); anything moved -> lost (exit 3); a read that
   fails or an item this build cannot read -> unknown (side effects wait);
6. one confirming read of the probe (not held -> lost; could not tell -> the role is UNCONFIRMED and its first side effect
   reads the probe itself). A task takes the role once.

**A mint without a mirror** (step 4 refused or unknown) leaves this task NOT the relayer; its ledger instance holds a fence
nobody uses (the relayer is given `NO_RELAYER_ROLE`: it runs no pass). The previous holder is fenced in the ledger from the
mint on and exits at its next attempt or self-check; the next takeover mints a newer epoch. That is the liveness price of
a mint in another account (it cannot share the mirror's transaction); the hint and the freshness gate keep it rare.

**The relayer's gates** (`escrow/juno/relayer.ts`, `RelayerDeps.authority` = the `RelayerRole`, or `NO_RELAYER_ROLE`):
- no pass at all while `authority.current()` is false (no verdict, no write, no side effect);
- `authority.beforeSideEffect(what)` at the last responsible moment before each external side effect -- `sign` (the KMS
  Sign of a new attempt, after the admission, the simulation and the gas decision), `broadcast` (a new attempt's first
  hand-off, after its journal write and its store write) and `rebroadcast` (a stored attempt's same bytes); a refusal
  writes nothing, spends no failure budget, and leaves a stored attempt live for the next pass or the next relayer;
- the admission is never the licence: between an `ok` and a new attempt's broadcast stand the ledger write (relayer fence
  + generation) and the intent write (ROLE_RL), each evaluated by DynamoDB after the admission. What the gate cannot close
  (a pause right after a passing check) is at most a rebroadcast of bytes already journalled and stored, which the new
  relayer knows and would send itself: one transaction per sequence;
- F-L5-2: a KMS `unavailable` answer backs off on the outage's streak and spends no failure budget (it used to hold an
  intent after six); a key the service REFUSES still holds it.

**What L5-7 wires** (done: §8; in the §6 order, step 2, primary only, after the identity writer):
- open the ledger with the relayer account and `onFenced: ledgerFencedHook(writer)` (the ledger's fence refusals are the
  pool writer's loss);
- `takeRelayerRole(writer, { ledger, now })` -> `taken`: `role`; anything else: `NO_RELAYER_ROLE` (retry later; never
  reuse a ledger instance's held fence -- a new takeover mints anew);
- the relayer's view: `createDynamoIntentStore({ client, table, fence: writer.fence, relayQueue: <account>, relayerRole:
  role.intentStoreRole() })`;
- `openJunoBackend({ ..., journal: ledger, intents: <the owner's game-fenced store>, relayerIntents: <the relayer's
  view>, relayerAuthority: role })` -- both relayer options or neither (refused otherwise);
- the relayer's load (the chain's sequence and the forgotten-attempt guard over the ledger's attempts, then the open
  intents and the live attempt) runs only after the takeover, before any pass -- the backend's verification and load do
  that already.

## 8. The AWS runtime (L5-7): `aws/runtime/`, `GS_STORAGE=aws`

The one composition of §4-§7 into the running server. It decides ORDER and REACTION only; every durable mechanism is the
certified substrate's. PROCESS mode (the data directory, the file stores) is unchanged and loads no AWS code.

| File | What it is |
|---|---|
| `storageMode.ts` | `GS_STORAGE` / `--storage`: `file` (absent: PROCESS mode) or `aws`; anything else exit 2. Imports nothing (`start.ts` reads it on every start) |
| `awsMain.ts` | `start.ts`'s AWS entry (loaded only for `aws`): the references, the documents from SSM, the clients, the runtime, the stop signals, the exit codes, the banner |
| `runtimeConfig.ts` | The references (environment) and the runtime document `18COSMOS/AWS-RUNTIME/v1`, both strict; `checkEscrowConfigForAws` |
| `configSource.ts` | SSM (a plain `String` parameter by ARN) and Secrets Manager (a secret by its complete ARN, into memory, a `SecretValue` that never prints) |
| `awsRuntime.ts` | The startup order, readiness, the loss and fail-fast reactions, the graceful shutdown -- over the `AwsSubstrate` port |
| `awsSubstrate.ts` | The real substrate: each method one call into §4-§7 with this task's clients, tables and generation |
| `kmsGate.ts` | The pool writer's side-effect gate before every KMS `Sign`, and the KMS failure-class counters |
| `consoleOps.ts` | The audit lines on stdout (`AUDIT {...}`, the file recorder's event names, redacted) for CloudWatch Logs |
| `../../ingress/readiness.ts` | `/gs/readyz` (and the standby's HTTP server) |

**The environment holds references only.** `GS_MODE=production` (required), `GS_STORAGE=aws`,
`GS_AWS_CONFIG_PARAMETER=<SSM parameter ARN>` (or `--aws-config`), and as in PROCESS mode `BUILD_ID`, `PORT`,
`GS_ALLOWED_ORIGINS`, `GS_TRUSTED_PROXY_HOPS`, `ESCROW_MONEY_TABLES`. Refused with the reason: `DATA_DIR` / `--data`,
`ESCROW_JUNO_CONFIG` / `--escrow-config`, and any of `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`
(the task role is the only credential source; a value is never read into a message). The task id is random per process
(`t-<16 hex>`).

**The runtime document** (one SSM `String` parameter; no secret in it; every field required, nothing else allowed):
`format` `18COSMOS/AWS-RUNTIME/v1`, `environment` (a label), `region` (the app account's: game and identity tables),
`pool`, `generation` (the ledger's adopted APPGEN this task is for), `game_table`, `identity_table` (names),
`ledger_table_arn` (the full table ARN, cross-account; its region is the ARN's), `escrow`: `null` or
`{config_parameter_arn}` -- the Juno configuration, `18COSMOS/JUNO-BACKEND/v3`, itself an SSM `String` parameter, which must
name the SAME ledger (`journal: {kind: "dynamodb", table_arn}`) and KMS keys only. Any problem: exit 2. Nothing falls back.

**The startup order** (`awsRuntime.ts` header): the generation (read only: APPGEN must equal `generation`, before the pool)
-> `PoolWriter.take` (onLost = exit 3), `start()`, `watchGeneration` -> primary only: `takeIdentityWriterRole` ->
`createDynamoIdentityStore({ epoch })` -> `IdentityService.open(store, { security: { journal (SEC#, generation), grants } })`
-> with escrow: the ledger (`generation`, the relayer account, `onFenced: ledgerFencedHook(writer)`) -> `takeRelayerRole`
-> every L5-2 store with `writer.fence` (owner intents game-fenced, the relayer's view ROLE_RL) -> the Juno backend
CONSTRUCTED (KMS keys through the gate; `preload: false`) -> `createPoolGameOwnership({ onClaimed: refreshRoster })` -> the
settlement index -> the game server (`ownership`, `readiness`, bound to `0.0.0.0`) -> discovery -> the first money claim
sweep that completes (then every 60 s) -> READY -> `backend.start()` (verify, the escrow load, the relayer's load) -> the
settlement walk. A stop asked for before the startup finishes ends it (exit 0) and is checked before every takeover.

**Not primary: a standby.** It holds its pool, takes no role, opens no identity, claims nothing, serves no player (this
build has no IdentityVerifier), and `/gs/readyz` is 503 `not-primary`; its HTTP server answers `/gs/healthz` and nothing
else.

**The relayer role.** Taken at startup (before the backend exists, so the escrow load's relayer load follows it). Not
taken: NO relayer authority (no pass, no Sign, no broadcast), retried every 30 s once the backend is `active`; a role taken
by a retry is published only after `relayer.load()` has run after that takeover. Each retry mints anew; a fence is never
read back and adopted.

**KMS.** The configuration's one KMS region; every `Sign` of the three keys waits for `writer.beforeSideEffect()` first
(`kmsGate.ts`) -- the same gate the relayer's role asks; withheld: `SignerError("unavailable", signatureMayExist: false)`,
nothing sent to KMS.

**Readiness.** `/gs/readyz`: 200 only while serving (startup done, not stopping), the pool writer not lost and checked good
within 25 s, the identity writer loaded, the first sweep done, no store asking for a restart; else 503 with fixed reason
codes (`starting`, `money-sweep-pending`, `pool-writer-unconfirmed`, `pool-writer-lost`, `lost`, `store-uncertain`,
`shutting-down`, `not-primary`). Public body: codes, pool, epoch, role and escrow states only. `/gs/healthz` is unchanged.

**Loss and fail-fast.** Loss (the pool writer's `onLost`; the identity store's, the SEC# journal's and the ledger's
`onFenced` all route to `writer.markLost`): timers and the relayer stop, exit 3 at once. A store that cannot settle a write
(identity's or a game store's `onRestartRequired`): exit 4 after 1.5 s. Neither drains; a stop never turns either into 0.

**The graceful shutdown** (SIGTERM/SIGINT/SIGHUP/SIGBREAK, IPC `shutdown`): readiness 503 -> timers stopped -> the
in-flight sweep and relayer retry drained -> money tables and settlement stopped -> the backend stopped (a start in flight
waited for, bounded, and stopped again; once stopped it neither loads nor re-arms its verification) -> the game server
closed -> escrow jobs drained -> ownership settled -> chain-facts holds -> `identity.settled()` -> the pool writer's
self-check stopped -> audit flushed -> exit 0. Each drain is bounded so the whole fits Fargate's 120 s `stopTimeout`; a
loss or restart request during it stops it with its own exit code.

**The import boundary** (`awsClients.test.ts`): `aws/runtime/` is the one place allowed to import `aws/game`,
`aws/identity`, `aws/ownership`, `aws/ledger` and `aws/kms` together (the ownership layer keeps its own rights; the
conformance suites theirs); nothing else imports `aws/runtime/`, except `start.ts` (`storageMode` statically, `awsMain`
dynamically). The SSM and Secrets Manager packages only in `awsClients.ts` and `configSource.ts`.

**For L5-8 (IaC), what the runtime needs** (the L5-7 report has the complete contract): the three tables (game with the
generation in its name, identity with TTL `ttl`, ledger in the ledger account with APPGEN initialised to the document's
`generation`); `SYSTEM/ROUTING` naming the primary pool before its first task starts; the two SSM `String` parameters; the
three KMS keys; the task role (DynamoDB, KMS, SSM read) and no static credentials; the container on `0.0.0.0:$PORT`
reached only from the ALB; the ALB target health check `/gs/readyz`, the container health check `/gs/healthz`;
`stopTimeout` 120 s; and the edge forwarding `/gs*` query strings unchanged (`cp`, `cr`, `cb`).

Run: `npm test` includes `aws/runtime/l5_7AwsRuntime.test.js`; `npm run test:dynamodb-local` includes
`persistence/conformance/awsRuntime.dynamoLocal.test.js` (the runtime over the real substrate).
