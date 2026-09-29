# AWS clients, DynamoDB Local and the game table — the LIVE-5 convention

LIVE-5 L5-1 set this up so that every later LIVE-5 slice uses one convention. L5-2 (the game table), L5-4 (identity),
L5-5 (the ledger and KMS) and L5-7 (the AWS wiring) all follow it; none of them should pick its own.

## 1. Creating a client: `awsClients.ts`, and nowhere else

A client is created only by `createDynamoDbClient(target)`, or by the matching factory a later slice adds to this same
file. The test `awsClients.test.ts` scans `server/src` (ES imports, `require` and dynamic `import`) and enforces:

- no other source file constructs a DynamoDB client (`DynamoDBClient` or the aggregated `DynamoDB`);
- nothing uses the document client: it marshals values, and stored bytes must be exact;
- no other `@aws-sdk/*` package is imported until a slice needs it, and nothing reaches into `@smithy/*`;
- no file outside `persistence/conformance/` imports the conformance harness or its proof adapter.

| Concern | Rule |
|---|---|
| **Target** | Always explicit. `{ kind: "dynamodb-local", endpoint }` is for tests and development. `{ kind: "aws", region }` is for real AWS (L5-7 wires it; nothing constructs it in L5-1). |
| **Endpoint override** | Only for DynamoDB Local, and only a plain `http://` loopback endpoint (`localhost`, `127.0.0.1` or `[::1]`) with an explicit port and no path, query or credentials (`localEndpointProblem`). An `aws` client sets `ignoreConfiguredEndpointUrls`, so `AWS_ENDPOINT_URL*` and profile endpoint settings cannot redirect it. |
| **Region** | Local: the fake region `gs-local`, which is not an AWS region. AWS: an explicit, validated region. The region is never taken from the environment or instance metadata. |
| **Shared config file** | Both targets pin every setting a profile line or environment variable could otherwise change (`PINNED_CLIENT_SETTINGS`): no configured endpoint URL, no FIPS or dual-stack endpoint, and the standard retry mode, never the adaptive rate limiter. The test runs under a hostile `AWS_CONFIG_FILE` and environment. |
| **Credentials** | Local: fixed alphanumeric dummy keys (`gslocaltest`). DynamoDB Local refuses other characters. Because the keys are fixed, the default credential chain is never consulted: no profile credentials, environment keys or metadata endpoint are used. AWS: the SDK default chain, which on ECS is the task role. Secrets never go in environment variables (preflight §11.6). |
| **Retries** | Off in the SDK (`maxAttempts: 1`). An authoritative write is resent only by its adapter, with the **same** `ClientRequestToken`. A conditional failure on a resend is settled by a strong read (preflight D-3, §4). A generic SDK retry would sign a new request and could turn one write into two. |
| **Timeouts** | Connect 2 s. Request 5 s, the actor's E-11 store deadline. `throwOnRequestTimeout: true` is required: without it the SDK only logs a timeout. An adapter treats a timeout as an **unknown** outcome, never as a failure. |
| **Abort** | Every call passes `{ abortSignal: deadline() }`, which bounds the whole call (default 8 s). |
| **Services** | DynamoDB only, for now. The KMS, SSM and Secrets Manager clients are added here by the slice that first calls them, with the same rules. |

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
still refuse the write. The cases are LOG-20, REC-18, HOLD-12, FIN-11, INT-12, TKT-11, ID-14 and JNL-12. The file
stores fail them, because they check their fence before writing (F-L5-4). `fenceGap.test.ts` pins that per port, which
also proves each case detects a check-then-write store.

The one DynamoDB adapter in L5-1, `dynamoProofFinancialStore.ts`, is a **proof only**, for the harness. It is not
production code and not the L5-2 design.

L5-2 added two capabilities every `dynamodb` subject must also declare: **`cas-in-write`** (a write's own condition --
create-if-absent, the version CAS, the log's next index -- is evaluated inside the write; race cases LOG-28, REC-21,
HOLD-16, FIN-19, INT-16, TKT-14) and **`inject-unevaluated`** (hook `armUnevaluated`: every resend fails unevaluated, reads
work; a visible write is committed, an invisible one UNCERTAIN). Each game-table port also has a second fence-inside-the-
write case (LOG-25 chat, REC-19 join code, HOLD-13 release, FIN-16 create, INT-13 create, TKT-12 first ledger). The file
stores fail every one of these for the right reason; `fenceGap.test.ts` pins it.

## 4. The game table (LIVE-5 L5-2): `aws/game/`

Six adapters behind today's ports, over ONE table (`pk`/`sk` strings, no secondary index): `createDynamoLogStore`,
`createDynamoRecordStore`, `createDynamoHoldStore`, `createDynamoFinancialStore`, `createDynamoIntentStore`,
`createDynamoTicketStore`. **Not wired into the server** (L5-7 does that; `awsClients.test.ts` refuses any other importer).

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

Run: `npm run test:dynamodb-local` (both files: the L5-1 proof and `dynamoGame.conformance.test.js`).
