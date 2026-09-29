# AWS clients and DynamoDB Local — the LIVE-5 convention

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
