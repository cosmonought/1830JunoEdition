# AWS clients, DynamoDB Local, the game table, identity, ownership, the relayer role, the AWS runtime, non-primary routing, the operator tooling and generation recovery — the LIVE-5 / LIVE-6 convention

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
- (L5-8) the deploy bootstrap and verifier, `aws/deploy/`, may read the routing (`aws/game/routing`, `gameTable`), the
  ledger's APPGEN (`aws/ledger`), the KMS digest client (`aws/kms`) and the runtime's document loader (`aws/runtime/`
  `awsMain`, `configSource`, `runtimeConfig`) -- never the identity adapters or the ownership layer -- and only
  `tools/awsDeploy.ts` imports it (§9);
- no file outside `persistence/conformance/` imports the conformance harness or its proof adapter.
- (L6-1) the identity verifier's reader (`identity/identityVerifier.ts`) and the directory (`ownership/gameDirectory.ts`)
  are reached, like every adapter, only through the runtime composition (`runtime/awsSubstrate.ts`).

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

**L5-8 (IaC, done -- §9)**: the identity table's TTL attribute is `ttl` (`infra/aws/modules/app/tables.tf`); the ledger
table's `APPGEN` / `APPGEN` (`current_generation`) is created before the first start by `npm run awsDeploy -- bootstrap`.

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

**LIVE-6 L6-7: the deferred L5-6 items** (`escrow/juno/relayer.ts` header; report: Project
`claude/LIVE6_L6_7_RELAYER_DURABILITY_SCALE_2026-09-30.md`):
- **discovery:** a store with a relay queue (`ChainIntentStore.relayQueue`, the DynamoDB store's `RELAYQ#<relayer>`) makes
  the queue the relayer's work -- its load reads the queue (every page, strict: one malformed entry fails the load) and
  each queued intent by its key, never `LIST#intent` or a game's partition; a queued intent that is gone, or terminal
  (confirmed by a second queue read), is a reported disagreement (`chain.relay-queue-mismatch`, a page), never work; a
  pass re-reads the queue at most once per idle interval. The file stores keep no queue: their load is unchanged;
- **the bounded guard:** the forgotten-attempt guard reads the ledger from the chain's current account sequence on
  (`attemptsFrom`: one key range of `ATTEMPT#<account>`), and ignores an attempt whose expiry height has passed;
- **F-L5-17:** only chain and contract answers spend an intent's failure budget (the hold); an operational failure (the
  game table, the financial record, the ledger, a local step) backs off in memory, writes nothing, and pages when its own
  streak reaches the budget;
- **F-L5-16 wait + page:** `chain.relayer-page` / `chain.relayer-page-cleared` audits and `status().paging` -- an
  unserved deployment's intent and a queue disagreement at once; an undecided verdict and failing passes after 5 minutes;
- **the escrow load** (and its chain sweep) visits the open money games only (`openMoneyGames` =
  `DynamoFinancialStore.openMoneyGameIds`: FINKEYS -> FINIDX#, strict), never `LIST#fin`.

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

**Not primary: a non-primary task** (LIVE-6 L6-1, §9; L5-7's standby, which served nobody). It holds its pool, takes no
role, opens no identity writer, claims nothing and writes nothing; it authenticates sockets through the identity verifier
and answers games with a route. `/gs/readyz` is 200 `non-primary` while its pool is held and freshly checked.

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

**For L5-8 (IaC), what the runtime needs** (the L5-7 report, §14, has the complete contract; L5-8 built it -- §9): the three tables (game with the
generation in its name, identity with TTL `ttl`, ledger in the ledger account with APPGEN initialised to the document's
`generation`); `SYSTEM/ROUTING` naming the primary pool before its first task starts; the two SSM `String` parameters; the
three KMS keys; the task role (DynamoDB, KMS, SSM read) and no static credentials; the container on `0.0.0.0:$PORT`
reached only from the ALB; the ALB target health check `/gs/readyz`, the container health check `/gs/healthz`;
`stopTimeout` 120 s; and the edge forwarding `/gs*` query strings unchanged (`cp`, `cr`, `cb`).

Run: `npm test` includes `aws/runtime/l5_7AwsRuntime.test.js`; `npm run test:dynamodb-local` includes
`persistence/conformance/awsRuntime.dynamoLocal.test.js` (the runtime over the real substrate).

## 9. The infrastructure and the deploy bootstrap (L5-8): `infra/aws/`, `aws/deploy/`

**Defined and tested; nothing deployed.** The runbook -- accounts, resources, IAM, the deploy order, the rollout, the
verifier, secrets, the owner prerequisites -- is `infra/aws/README.md`; the record is the L5-8 report
(`claude/LIVE5_L5_8_AWS_INFRASTRUCTURE_2026-09-30.md`). What changed for this convention:

| File | What it is |
|---|---|
| `deploy/bootstrap.ts` | APPGEN (`{schema 1, current_generation N}`, create-if-absent) and SYSTEM/ROUTING (L5-3's `setPrimaryPool`, create-if-absent): inspect both, refuse the whole bootstrap on any incompatible or unreadable record, never reset, settle a lost answer by reading back |
| `deploy/deployVerify.ts` | The read-only checks: the documents (through `loadAwsStartup`), the tables, APPGEN / routing, the KMS keys, and the control-plane evidence (pure checks over AWS CLI JSON -- no ECS / ELB / CloudFront / EC2 SDK in the server) |
| `deploy/commands.ts`, `deploy/wiring.ts`, `../tools/awsDeploy.ts` | `npm run awsDeploy -- bootstrap | verify | signer-keys`; the production ports are the runtime's own (`ssmParameterSource`, `kmsDigestClient`), the clients `awsClients.ts`'s |

The task's environment, the task role's action list, the two documents and the edge requirement are exactly §8's; the
Terraform module tests assert them (`infra/aws/modules/*/tests`), and `deploy/l5_8Deploy.test.ts` feeds the rendered
documents (`infra/aws/fixtures`) to the runtime's parsers. Run: `npm test` includes `aws/deploy/l5_8Deploy.test.js`;
`npm run test:dynamodb-local` includes `persistence/conformance/awsBootstrap.dynamoLocal.test.js`.

## 10. Non-primary serving and routing (LIVE-6 L6-1)

The pieces that let a task which is NOT the primary pool's serve anything, and let any task answer a game it does not
serve with a destination. Nothing here writes; the primary's write path is unchanged.

| File | What it is |
|---|---|
| `../identity/verifier.ts` | The `SessionVerifier` port and its decisions: the writer's `authenticate` / `isProfiled` / `socketVerdict`, decision for decision, over single-record reads; no cache, no write, fail closed |
| `identity/identityVerifier.ts` | Its reader on the L5-4 identity table: strongly consistent `GetItem`s of `SESS#` / `PRIN#` / `FAM#` / `PROF#`, L5-4's strict `decodeItem`; never the role item, never a write |
| `ownership/gameDirectory.ts` | Strong reads for a task that claims nothing: a game's HEAD (owned / released / absent; anything else is damage), `SYSTEM/ROUTING`, a record's `META` (L5-2's classification) |
| `../rooms/gameRoutes.ts` | The trusted route table (`poolRoutes`, `routeEntryProblem`), the owner -> destination lookup (`routeOfGame`), and the frozen LIVE-4 frame (`ownershipRouteFrame` = `routeFrameFor`) |
| `../routerServer.ts` | The non-primary task's server: `/gs/healthz`, `/gs/readyz`, and the socket -- the same upgrade gate (`decideVerifiedUpgrade`), every frame's session re-checked from the records, `hello` / `room-hello` answered with a route, everything else `unavailable` |

**Which pool, and which path.** A route's POOL comes only from authoritative data read at the question: on a task whose
load claimed the game, the claim's own refusal (`GameRoutedError`, the HEAD's owner as the table evaluated it); on a
non-primary task, a strong read of the HEAD -- a released game is the primary's, from a strong read of `SYSTEM/ROUTING`.
Its PATH comes only from the trusted runtime document v2's `routes` (`18COSMOS/AWS-RUNTIME/v2` = v1 + `routes: {"<pool>":
{"ws_path": "/gs/...", "bundle_path"?: "/..."}}`): plain absolute paths the client's own `safeRoutePath` accepts, a socket
path under `/gs/`, never a host. Nothing a client sends -- a frame field (the closed schema refuses it), the query, Host
or X-Forwarded-* -- names a destination. No destination (an operator run, this pool, a pool with no entry, a HEAD or a
routing this build cannot read, no routing): the answer is exactly today's `unavailable`. A v1 document has no table.

**The frame.** LIVE-4's `route` frame, built by the frozen `routeFrameFor` (client protocol 1's only route code), then
close 4426 -- only to a protocol-1 socket whose frozen connection verdict is `ok`, after its authentication and after the
game's record authorized the principal to read the game (an outsider of a private game, or an unknown id, gets
`not-found`). The legacy wire never sees it. The pool it names authenticates, authorizes and judges the tab again.

**Each pool answers its own path.** The game server (and the router) accept `/gs` and their own pool's `ws_path`; the
load balancer's rule for each `ws_path` must send it to that pool's tasks (L6-2 / IaC).

**The routing watch.** Every 5 s the task reads `SYSTEM/ROUTING` strongly. A proven change of its serving role -- a
well-formed routing naming this pool on a non-primary task, or another pool on the primary -- runs the graceful shutdown
(the router closes its sockets 1012) and exits **5** (`EXIT_ROLE_CHANGED`); the restart takes the role the routing names
through the certified startup order (a promoted task takes the identity-writer role inside the transaction conditioned on
the routing and its pool epoch, BEFORE it loads identity). Unreadable or absent routing proves nothing. A loss during that
drain keeps exit 3. The operator's flip procedure itself is L6-2's.

**A demotion gives back what it can.** A primary that stops for a role change releases its resident, loaded, unfenced
NO-MONEY games (the eviction rule) after its sockets close, so the new primary claims them at their next load. Still owned
by the demoted pool, and so unservable until L6-2's flip procedure (or a retired-pool claim / draining serving): money
games, a game whose load was still in flight at the flip, and every game of a task demoted by a fence (exit 3, no drain).
The primary's sockets close 1001 at a demotion (the game server's close), the router's 1012; clients treat both alike.

**What a non-primary task does NOT do:** take the identity-writer or relayer role, open an identity store, a ledger, a KMS
client or any game store that writes, claim or release a game, run a money sweep, or write any identity or game item.

## 11. The operator tooling (LIVE-6 L6-3): `aws/operator/`, `gamesDoctor aws ...`

The operator's view of, and narrow controls over, an AWS deployment. `gamesDoctor aws <command>` (the FIRST word must be
`aws`; only then is `aws/operator/operatorMain.ts` loaded -- every file-mode command is unchanged and loads no AWS SDK or
AWS module). Its import rights are an explicit list (`awsClients.test.ts` `OPERATOR_IMPORTS`: the readers and its
mutations' own primitives; no store commit, ledger, identity writer or role takeover), and only `tools/gamesDoctor.ts`
reaches it.

| File | What it is |
|---|---|
| `operatorTarget.ts` | The deployment, named as a task names it (L5-7): `--aws-config <SSM parameter ARN>` / `GS_AWS_CONFIG_PARAMETER`, the runtime document `18COSMOS/AWS-RUNTIME/v1` via L5-7's `ParameterSource` and parser; with escrow, the Juno v3 configuration only for the relayer ACCOUNT. Static keys in the environment refused by name; `--data` / `--escrow-config` refused. DynamoDB Local: `GS_DYNAMODB_LOCAL_ENDPOINT` + `--local-document <file>` [`--relayer <account>`] |
| `inspect.ts` | Read-only answers, each `absent` / `ok` / `unreadable` (`corrupt` or `newer`) / `unavailable` -- never collapsed: the routing, APPGEN, the pools it can name (no scan), the identity-writer role and its holder, the relayer mirror against the ledger fence (`readRelayerFence`, L6-3's one ledger export), a game's HEAD owner class (released / current / superseded / operator / orphaned / ahead / inconsistent / unknown) and the claim / take / release verdicts, the directory and the open money games |
| `mutations.ts` | `set-primary` (L5-3's `setPrimaryPool` CAS at `--expect-version`; never the first routing -- L5-8 -- never `op:`, never a pool with no item); an operator run's `claim` (a released game) / `take` (a SUPERSEDED owner, proven inside the transaction) / `release` (`--run`). The design, the ABA argument and the stopped live-owner take are in its header |
| `operatorMain.ts` | The CLI: text or `--json` on stdout, `AUDIT {...}` on stderr; exit 0 / 1 (findings, refused, conflict) / 2 (usage, refused reference) / 3 (unknown outcome) |

**Every mutation**: a dry run unless `--apply` (nothing written, not even evidence); `--note` required (printable, never
credential-shaped); the item read strictly and the write bound to exactly that state; the run's evidence `OPRUN#<run>` /
`OPRUN` written FIRST (no evidence, no change) and `RESULT` after; a lost answer settled from the table. An operator run is a
pool `op:r-<16 hex>` taken at epoch 1 for its one claim and RETIRED (moved past 1) as soon as that claim has an answer, so
no copy of it can ever land later; its hold is the HEAD's `(run, 1)`, which only `release --run` ends.

**Not here:** the first `SYSTEM/ROUTING` and `APPGEN` (L5-8's bootstrap); generation adoption / restore (L6-4: APPGEN is
read only); the flip / retirement procedure (L6-2, §13: `set-primary` is its primitive); a take from a CURRENT owner (it needs a
per-claim generation on the HEAD carried by every game fence -- the L6-3 report); hold / money release over DynamoDB under
an operator hold (a later slice). Note for L6-2 / L6-4: `POOL#op:r-*` and `OPRUN#*` items live in the game table (a pool
enumeration must skip `op:` pools; they go with the table's generation).

Run: `npm test` includes `aws/operator/l6_3Operator.test.js`; `npm run test:dynamodb-local` includes
`persistence/conformance/operatorTooling.dynamoLocal.test.js`.

## 12. Generation adoption and the identity restore (LIVE-6 L6-4): `aws/recovery/`, `aws/ledger/appGeneration.ts`, `aws/game/generationMarker.ts`, `aws/identity/identityRestore.ts`

The RECOVERY boundary L5-4/L5-5/L5-7 deferred. The first deployment's bootstrap of APPGEN, `SYSTEM/ROUTING` and (new)
`SYSTEM/GENERATION` is L5-8's; general operator tooling is L6-3's. The full design, the restore sequence and the review:
Project `claude/LIVE6_L6_4_GENERATION_RESTORE_2026-09-30.md`.

| Item | Where | What |
|---|---|---|
| `SYSTEM` / `GENERATION` | game table | `{fmt 1, generation, game_table, origin bootstrap\|restore, restored_from_generation, restored_from_table, restore_point, restore_id, prepared_at, prepared_by, claim}` -- the generation this table's data belongs to. **The startup refuses (exit 2, before the pool) unless APPGEN = the document's `generation` = this item's `generation`, the item names the document's `game_table`, AND APPGEN's adoption binds this table (a restore marker: APPGEN adopted exactly this `game_table` and `restore_id`; a bootstrap marker: APPGEN never adopted) -- several copies may be prepared as one generation, only the adopted one serves.** L5-8 writes the first one (`bootstrapGenerationMarker`, create-if-absent); a restore's preparation rewrites the copied one (CAS on exactly the copied item) |
| `APPGEN` / `APPGEN` | ledger | bootstrap `{schema 1, current_generation}`; adopted: + `previous_generation, adopted_at, adopted_by, restore_id, game_table, claim` (read strictly by `appGeneration.ts`; the fences read only `schema` and `current_generation`) |
| `APPGEN#HISTORY` / `GEN#<M:20>` | ledger | one per adopted generation, in the adoption's own transaction, `attribute_not_exists`: a generation is adopted at most once, ever |
| `RESTORE#identity` / `RESTORE` | identity table | `{restore_id, state replaying\|complete\|superseded, identity_table, peer_table, restore_point, started_at, journal_digest, journal_events, completed_at, reviews}`. The table serves only while `complete` AND `identity_table` names itself: mid-replay, a restore's superseded SOURCE and a copy that carried another table's marker serve NOTHING -- a serving load refuses them (`IdentityRestoreIncompleteError`) and every serving identity-writer takeover carries `identityServingChecks` inside its transaction |
| `REVIEW#<pf>` / `REVIEW#<restore>` | identity table | a profile sent to operator review (an unconfirmed key rotation): the restore, the event ids, what the replay did to the key; never a selector or a digest. One per restore; a replay withdraws only its OWN review (a confirmation arrived since), and re-enables the profile only if no other restore's review is open |
| `TABLE#identity` / `TABLE` | identity table | `{identity_table}`: the table's own name, set inside every serving identity-writer takeover (create-if-absent, else it must already name this table) and rewritten only by a restore's completion. A point-in-time copy carries its source's name: it serves nothing until its own replay completes |

**The adoption** (`adoptGeneration`): strong reads first -- APPGEN present and readable (newer: refused, never overwritten),
the caller's `expected` is current, the new generation is strictly greater and has no history item, the target game table
is PREPARED for exactly this adoption -- then ONE transaction `[Update APPGEN COND schema = 1 AND current_generation =
:expected AND <exactly the item read: its claim, or none>; Put history COND attribute_not_exists]` with a fresh token (the
`claim`). Outcomes `committed` / `already-adopted` (idempotent re-run: nothing written) / `conflict` (another move or a
reused number: nothing written, nothing overwritten) / `refused` / `unknown` (no answer and APPGEN exactly as read: ask
again with the same request; at most one attempt can ever land). From the moment it lands every ledger write of the old
generation is refused inside the write, every old task's pool writer proves its loss at its next self-check (exit 3,
KMS withheld by the side-effect gate), and no task configured for the old generation starts. **Nothing ever follows
APPGEN**: the probe, the ledger and the SEC# journal compare with the task's configured number; only a restart with the
new generation (and its prepared table) serves it.

**The identity restore** (`applyIdentityRestore`): the marker read first (`complete` by this restore on this table: nothing
written; a fresh start needs a table holding nothing stamped after the restore point) -> the journal read and the replay
planned READ ONLY (a journal that cannot be replayed is refused before anything is written) -> the SOURCE table's
identity-writer role fenced and the source marked `superseded` for good (or the source verified gone) -> the target's role
(pool `op:restore`) -> the marker `replaying` -> the whole `SEC#` journal (strict scan) -> the plan
(`identity/securityReplay.ts`: every session and family ended, link codes dropped, the journal's terminal actions
re-applied, profiles created after the restore point made, the confirmed key chain followed, an unconfirmed rotation
retired and never installed and its profile `disabled` under review; a confirmation lost in the MIDDLE of a chain is a gap
between confirmed segments: reviewed, never refused) -> per principal: its review record, then its change -> grants
removed -> verify (the same journal digest, nothing left to plan, exactly the planned reviews) -> the marker `complete` and
`TABLE#identity` naming the restored table, in one transaction. Interrupted anywhere: unserved; a re-run resumes (a
confirmation that arrived since withdraws the replay's OWN review). `planIdentityRestore` is the dry run: the same reads,
no write at all.

**Operator commands** (`npm run recovery -- <command>`, `aws/recovery/recoveryCli.ts`): `appgen-status`, `table-prepare`,
`appgen-adopt` (`--apply --stopped`), `identity-status`, `identity-replay` (`--apply`). Without `--apply` every one only
plans. One JSON answer, checked by `assertPrintable` (no selector, session or family id, no key or secret field).

**The import boundary**: `aws/recovery/` may import `aws/game`, `aws/identity` and `aws/ledger` (not ownership, KMS or the
runtime); nothing imports it but the conformance suites (`awsClients.test.ts`).

**For L5-8** (added to the L5-7 contract, §8): the first game table's `SYSTEM/GENERATION` = `bootstrapGenerationMarker({
generation, gameTable, by, now })` (a create-if-absent Put), with the same generation as APPGEN and the runtime document.
**IAM**: the operator/restore role -- ledger `GetItem`, `Query`, `UpdateItem` on `APPGEN` and `PutItem` on
`APPGEN#HISTORY` (leading keys `APPGEN`, `APPGEN#HISTORY`), `Scan` (the SEC# journal, read only); game tables `GetItem`,
`PutItem` on `SYSTEM/GENERATION`; identity tables `GetItem`, `Scan`, `PutItem`, `UpdateItem`, `DeleteItem`,
`ConditionCheckItem`. The task role needs nothing new (it reads `SYSTEM/GENERATION`: `GetItem`, already granted).

Run: `npm test` includes `aws/recovery/l6_4Recovery.test.js`; `npm run test:dynamodb-local` includes
`persistence/conformance/l6_4Recovery.dynamoLocal.test.js`.

## 13. The production flip, recovery and retirement (LIVE-6 L6-2): `aws/operator/{flip,recovery,retire,orphans}.ts`, `aws/controlPlane/`

The procedures are in `infra/aws/README.md` ("The flip", "Recovery", "Retirement", "Generation switch"); the design, the
review and the owner decisions in Project `claude/LIVE6_L6_2_ROUTING_FLIP_RETIREMENT_2026-09-30.md`.

| File | What it is |
|---|---|
| `controlPlane/evidence.ts` | Pure judgements over `capture-evidence` output (`18COSMOS/EVIDENCE/v1` manifest; per pool: target group, target health, services, stopped/running tasks, ACTIVE revisions; listener rules): a group per pool, healthy non-primary routers, `/gs*` -> primary and each exact `ws_path` -> its own group with the shadowing proof, the identity layout on every rollback target, exit 5 + replacement after a flip (3/4 abnormal), drain-first |
| `controlPlane/flipRecord.ts` | `18COSMOS/FLIP-EVIDENCE/v1`: the flip's machine-readable record (preflight checks, snapshots before/after, the CAS, the observability window, observations) -- written atomically after every phase; L6-6's evidence and `awsDeploy verify --flip-record`'s input |
| `operator/flip.ts` | `flip` / `flip-observe`: F0 preflight (dry run stops here, writes nothing) -> F1 window opens -> F2 L6-3's `setPrimary` CAS -> F3 observation by strong reads until BOTH pools were re-taken and B's CURRENT task holds the singleton roles (only the restarted tasks can satisfy it) or the bound passes (`timeout`: stop) |
| `operator/recovery.ts` | `recover <A>`: superseded HEADs of A -> L6-3 `take` + `release` (marker `[l6-2-recover from=A]` in the note); resumes its own interrupted holds; never a current owner, another run's hold or damage; waits (bounded) for the primary's money sweep to claim each open money game; `settled` closes the window |
| `operator/retire.ts` | `retire-check <pool>`: R1-R6 (read-only). No durable `POOL#.status` marker is built (its header says why) |
| `operator/orphans.ts` | `orphans`: after a restore, ledger `SETTLE#`/`ATTI#` no game of the adopted table accounts for (read-only; chain games NOT COVERED) |

**L6-4 integration** (the addendum): the bootstrap creates-if-absent `SYSTEM/GENERATION` with L6-4's own helpers (all three
records inspected before any write); `awsDeploy verify` and the flip preflight check the marker and the adoption binding
with L6-4's `generationMarkerProblem` / `adoptionBindingProblem`; the identity verifier refuses every table
`identityServingProblem` refuses (`servingGatedVerifier`); `awsDeploy generation-gate` (read-only) opens the Terraform
generation switch only after the exact adoption; a restored table's money games are read-only until the escrow service's
`restoreCheck` (F1 history + the ledger/chain quorum) passes in THIS process -- never stored, so no restart bypasses it.

**Relayer-address rotation** (for L6-7): `aws/deploy/relayerRotation.ts` + `awsDeploy relayer-rotation-gate` -- read-only;
open only when the active configuration still names the old address, every pool is drained, and `RELAYQ#<old>` read
completely (strong, every page; entries never parsed -- any entry is open work) is empty. Unknown refuses; the new queue is
never read. No queue migration exists (owner decision).

Import rights (`awsClients.test.ts`): the operator may read `aws/game/generationMarker` and `aws/ledger/appGeneration`, never
call `adoptGeneration`, `prepareRestoredTable` or `applyIdentityRestore`; deploy may read the marker module.

Run: `npm test` includes `aws/operator/l6_2Flip.test.js`; `npm run test:dynamodb-local` includes
`persistence/conformance/l6_2Flip.dynamoLocal.test.js`.

## 14. Runtime observability (LIVE-6 L6-5A): `runtime/runtimeMetrics.ts`, `runtime/taskStatus.ts`

The application side of LIVE-6's observability; the CloudWatch alarms that consume it are L6-5B's (after L5-8's IaC).
The design, the full metric table and the exact alarm handoff: Project `claude/LIVE6_L6_5A_RUNTIME_OBSERVABILITY_2026-09-30.md`.

- **Metric lines.** CloudWatch Embedded Metric Format, one JSON object per stdout line (the awslogs driver ships it;
  CloudWatch Logs extracts the metrics -- no agent, no header, no `PutMetricData`). Namespace `18Cosmos/GameServer`,
  schema 1. **Dimensions: `Environment` and `Pool` only** (the forced-exit and failure counters also under
  `[Environment]`); the task id, build, generation, epoch, reason codes and states are properties, never dimensions; no
  game, player, principal, session, wallet, transaction, key, ARN or error text is ever in a line (a second fence redacts
  those shapes). Counters are occurrences per record (alarm on `Sum`); gauges are states at a status tick (never `Sum`).
- **Where each is counted: once, at the decision.** `TaskLost` in `lose` and `StoreUncertain` in `failFast` (after the
  terminal guard: one forced exit, one count; the loss's `cause` is a fixed code, and a PROVEN newer task of the pool is
  also `TaskSuperseded` -- the rolling-deploy loss); `StartupRefused` in `refuse` (exit 2 only; its `stage` is the last
  step); what is still pending (KMS deltas, carried transitions) rides on these records; one record per money claim sweep pass; one per relayer takeover attempt and
  per relayer state change; readiness only when it CHANGES (observed at `/gs/readyz`, the status tick and the phase
  changes; at most 20 transition lines a minute, the rest carried so `Sum` stays exact); the KMS metrics are deltas of
  `kmsGate.ts`'s counters, sent at the 30 s status tick (the only KMS counters).
- **`TASK#<task>` / `TASK`** in the game table: the preflight's diagnostic status item (§3.2), written by the task itself
  every 30 s from its pool takeover on (and `stopping` at a graceful shutdown), one conditional `PutItem` (only a newer
  `seq`), TTL attribute `ttl` = last seen + 1 day. **Not an authority:** nothing reads it (a source guard), it is not
  fenced by the pool epoch on purpose (a stale-but-alive task must still show up), and its failure is counted and ignored.
- **Never a correctness dependency.** A metric line or a `TASK#` write that fails (or a sink that throws) changes no
  decision, fence, exit code, audit line or security-journal write.

**Converged (L6-5B):** the non-primary task (L6-1's router; L5-7's standby) is observed like the primary; it answers
ready, so it reads `Ready 1 / Unready 0 / Standby 1` and its role code is `non-primary`. TTL `ttl` is enabled on every
managed game-table generation (§15); the task role needs nothing new (EMF goes through its log group). Run: `npm test` includes `aws/runtime/l6_5aObservability.test.js`;
`npm run test:dynamodb-local` includes `persistence/conformance/taskStatus.dynamoLocal.test.js`.

## 15. The CloudWatch alarms and the planned-flip suppression (LIVE-6 L6-5B)

The IaC half of LIVE-6 observability, on the converged runtime (L6-2 spine + L6-5A + L6-7). The design, the alarm table,
the suppression state machine and the L6-6 handoff: Project `claude/LIVE6_L6_5B_CLOUDWATCH_ALARMS_2026-09-30.md`; the
procedures: `infra/aws/README.md` ("Alarms", "The flip", the gates).

| File | What it is |
|---|---|
| `runtime/runtimeMetrics.ts` | L6-5A's catalog + `RelayerPaging` / `Waiting` / `QueueMismatch` / `Troubled` / `OldestWaitingSeconds` (gauges from L6-7's `relayer.status()`, only while this task's relayer is usable), `StartupRefusedGeneration` / `StartupRefusedIdentityRestore` (the refusal's class, decided at the call site), `GenerationLost` (a loss to the generation fence), `MoneyHeldJournalAhead` (the escrow service's own `settlement.held` of code `journal-ahead`), `RestoreSafeMode` / `RestoreUnverifiedGames` |
| `../escrow/escrowService.ts` | `restoreStatus()`: a read-only view of the restore checks' last answers (verified / pending / held); it starts and decides nothing |
| `controlPlane/alarmContract.ts` | `ALARM_CONTRACT` (= `infra/aws/modules/app/alarm-contract.json`, pinned by a test) and `checkAlarmsEvidence` (the verifier's judge of `describe-alarms`) |
| `controlPlane/flipSuppression.ts` | The window's suppressor datapoints (pure): +1 per minute per pool, the flip's two pools, never past `expires_at` (45 min) or CloudWatch's future limit; a close writes -1 over the same minutes (additive: overlapping windows compose) |
| `operator/flipSuppression.ts` | The production publisher: CloudWatch `PutMetricData` into `18Cosmos/Operator` only (the only CloudWatch client in the server, operator-only) |
| `operator/flip.ts` | `suppressFlipWindow` -- called when the window opens (before the CAS) and when it closes (a refused CAS; `recover --flip-record` settled); never throws, never changes the flip |
| `deploy/gateRecords.ts` | `--record` of `generation-gate` / `relayer-rotation-gate`: the gate's own verdict, created once; `generationAttestationProblem` / `rotationGateRecordProblem` for certification |
| `deploy/deployVerify.ts`, `deploy/commands.ts` | `verify`: TTL `ttl` on every managed game generation (`--game-generations`), the alarms (`alarms.json`; `--page-actions` / `--ticket-actions`) |

**Nothing here is a correctness input.** A metric, a suppressor datapoint or a gate record grants, withholds or delays
nothing: no fence, readiness, exit code or audit line changes; the runtime never makes a CloudWatch client.

Run: `npm test` includes `persistence/conformance/l6_5bAlarms.test.js` (and L6-5B's block in `aws/runtime/l6_5aObservability.test.js`);
`npm run test:dynamodb-local` includes the §3c suppression drill in `persistence/conformance/l6_2Flip.dynamoLocal.test.js`;
`terraform test` in `infra/aws/modules/app` includes `tests/alarms.tftest.hcl`.

## 16. The staging certification, converged (LIVE-6 final convergence): `aws/deploy/staging/`, `tools/awsDeploy.ts`

L6-6's harness with L6-6R's recovery review and L6-6P's complete cluster listing, on the converged LIVE runtime (L5-7 ...
L6-7): every gate judges with the owning slice's own code. The report: Project
`claude/LIVE6_FINAL_CONVERGENCE_2026-09-30.md`; the procedures: `infra/aws/README.md` "Staging certification".

| File | What it is |
|---|---|
| `tools/awsDeploy.ts` | The ONE binding: `STAGING_RECOVERY_READERS` = L6-4's `readGenerationMarker`, `readAppGeneration`, the runtime's step 1 (`generationMarkerProblem` then `adoptionBindingProblem`), `readIdentityRestore` + `readIdentityTableSelf` + `identityServingProblem`, `inspectIdentityRestore`'s REVIEW# as `{restore_id, reason, open}` only, `readAdoptionRecord`; `STAGING_HEARTBEATS` = `runtime/taskHeartbeats.ts`. The import guard admits exactly these names. |
| `runtime/taskHeartbeats.ts` | The TASK# item's ONE reader (never the runtime's): the PREVIOUS generation's game table, strongly consistent, every page, decoded by `taskStatus.ts`'s `decodeTaskStatusItem` (the writer's exact inverse); a heartbeat of generation N after the restore-stop's `captured_at` fails restore-quiet; an unreadable table throws. Diagnostic only, never a lease. |
| `deploy/staging/drills.ts` | The converged gates: `alarms` (L6-5B's `checkAlarmsEvidence` + the capture's and the alarms' identity), `generation-gate` (L6-5B's `generationAttestationProblem` + the record's `adoption_claim` against the ledger's `APPGEN#HISTORY`), `flip` / `flip-alarms` (L6-2's record, `checkRoleChange`, `checkPoolListenerRules`, the complete listing; the drill's alarm observations), `relayer-rotation` (L6-5B's `rotationGateRecordProblem` + drained / old-queue / new-queue / ordering), `restore-alarms` (R1, A4g, A4i, R2, R3 observed firing, never suppressed). |
| `deploy/staging/recovery.ts` | L6-6R's gates, now fed live: `GenerationEvidence.history` (APPGEN#HISTORY of APPGEN's adoption) and `readRestoreHeartbeats` (the TASK# seam). |
| `identity/dynamoIdentityStore.ts` | `readIdentityTableSelf` (exported, unchanged: what `identityServingProblem` has always read). |

Run: `npm test` includes `aws/deploy/staging/l6_6StagingCert.test.js` (the convergence block at its end), `aws/awsClients.test.js`
(the binding's exact names) and `aws/runtime/l6_5aObservability.test.js` (the decoder, the widened TASK# guard);
`npm run test:dynamodb-local` includes `persistence/conformance/l6FinalConvergence.dynamoLocal.test.js`.

## 17. Relayer rotation: the second relayer key, the admin's operator change, the post-rotation proof (LIVE-6)

The rotation gate (§13, `deploy/relayerRotation.ts`) proves a relayer-address change is SAFE (every pool drained, the old
`RELAYQ#` empty, the new one never consulted). This slice makes the change IMPLEMENTABLE and makes its certification prove
it WORKED. The procedure: `infra/aws/README.md` "Relayer rotation"; the report: Project
`claude/LIVE6_RELAYER_ROTATION_PREP_2026-10-01.md`.

| File | What it is |
|---|---|
| `infra/aws/modules/ledger` | `relayer_key_count` (append-only, default 1 = unchanged): `relayer-r2`, `relayer-r3`, ... beside the original key (`r1`, its address unchanged), same spec, same key policy, `prevent_destroy`; output `relayer_key_arns`. With a rotation, the bootstrap role may GetItem `FENCE#relayer#*`. |
| `infra/aws/modules/app` | `relayer_rotation_key_arns`: the prepared next / retained previous relayer key -- READ by the bootstrap role only; the task role signs with exactly the configured `signing_keys`. While non-empty, the proof's GetItems (`ROLE#relayer#*`, `POOL#*`, `TASK#*`; the ledger's `FENCE#relayer#*`). |
| `deploy/junoChain.ts` | The deploy tools' READ-ONLY view of the escrow contract: `contractControl` (admin, operator, paused -- the server's own `parseConfigResponse`), `setOperatorMessage`, `perTransactionFeeCap` (min(`max_fee`, ceil(`max_gas` x gas price)): the largest fee `decideGas` can accept -- 112,500 ujunox by default), `relayerFunding` (LIVE-6 L6-12D: the one-game operational planning reserve, 73 relayer transactions -- Start 1 + Checkpoint 64 [a planning allowance, not a contract cap] + Settle 1 + Consent up to 6 + Finalize 1; retries excluded, bounded by hold-and-page -- x the per-transaction cap = 8,212,500 ujunox = 8.2125 JUNOX by default; every term reported; integers only), `relayerFundingDerivation`, `deploymentIdentityOf`, the REST binding `productionJunoChain` (and a bank balance read). Signs nothing. |
| `deploy/commands.ts` | `relayer-rotation-gate` also reads the contract's operator (old or new, else CLOSED) and writes `18COSMOS/RELAYER-ROTATION-GATE/v2` (the deployment to keep, the operator at the gate). `set-operator-plan` (read-only): `Config.admin` and the operator from the chain, the exact `set_operator` message for the admin to sign OUTSIDE the repository, the `--to-relayer` account on chain and >= the planning reserve (the derivation printed; READY at exactly the reserve, NOT READY one ujunox below), optionally the address derived from the prepared KMS key. The reserve is evaluated also when the operator is ALREADY `--to-relayer` (S2 doubles as the active relayer's readiness check: funded exits 0, under the reserve exits 1 with the shortfall). Rollback: the old relayer is topped up just in time, before the rollback's pools restart -- never pre-funded for the forward rotation. |
| `deploy/gateRecords.ts` | v2 rotation record; `rotationDeploymentOf`; a v1 record no longer certifies. |
| `deploy/staging/rotationProof.ts` | `collectRotationProof` (live, read-only, never throws) and `judgeRotationProof` (pure): the configuration names the new relayer; the contract's operator is it; contract and checksums are the gate's; `verifyJunoDeployment` verifies; the routing's primary's CURRENT task holds `ROLE#relayer#<new>` at the ledger fence's epoch; its own fresh `TASK#` says relayer `usable`; escrow `active` and not paused; settlement and admission keys = the gate's; `RELAYQ#<old>` still empty; and (`18COSMOS/L6-RELAYER-ROTATION-PROOF/v2`, LIVE-6 L6-12D) the new relayer account: the configured relayer KMS key's public key (`getPublicKey` -> `compressedKeyFromSpki`) derives (`addressOfPublicKey`, as `checkSignerIdentities`) exactly the configured new address, the account exists on chain and holds >= the planning reserve, and a PRESENT on-chain pub_key is the same key (absent is accepted and is not proof of control). A v1 reading is refused by name. Gate `relayer-rotation-proof` (certify.ts); the reading is kept as `rotation-proof.json`. |
| `runtime/taskStatus.ts`, `runtime/taskHeartbeats.ts` | The decoder also returns what the task said (`reasons`, `relayer`, `escrow`); `readTaskStatus` reads ONE task's item strongly for the proof. Still the one reader, bound only by `tools/awsDeploy.ts`; never a lease. |
| `tools/awsDeploy.ts` | `STAGING_ROTATION_READERS` = `readRouting`, `readPool`, `readRelayerRole`, `readRelayerFence`, `readTaskStatus`, `relayQueueState`; `deps.juno = productionJunoChain()`. The import guard admits exactly these names. |

Run: `npm test` includes `aws/deploy/staging/rotationProof.test.js`; `npm run test:dynamodb-local` runs §4 of
`persistence/conformance/l6FinalConvergence.dynamoLocal.test.js` (the bound readers over a real takeover's items).
