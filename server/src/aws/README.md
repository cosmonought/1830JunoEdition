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

## 4. Identity on DynamoDB (L5-4): `aws/identity/`

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

**What L5-7 wires** (nothing in `start.ts` uses these yet):
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
