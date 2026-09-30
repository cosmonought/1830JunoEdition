// server/src/persistence/conformance/awsRuntime.dynamoLocal.test.ts
//
// ==================================================================
//  LIVE-5 L5-7: THE AWS RUNTIME ON THE REAL SUBSTRATE -- ON DYNAMODB LOCAL
// ==================================================================
//
// Runs ONLY against a DynamoDB Local named by GS_DYNAMODB_LOCAL_ENDPOINT (`npm run test:dynamodb-local`); without one it
// FAILS with instructions. The runtime (`aws/runtime/awsRuntime.ts`) over `realAwsSubstrate` -- the certified L5-2 ... L5-6
// adapters as built, on real tables -- proving the COMPOSITION, not the adapters again:
//
//   §1 the primary: the generation checked, the pool taken, the identity-writer role taken (with the routing and pool
//      conditions) before identity loads; the game stores write under the pool writer's fence (a record's HEAD names this
//      task's pool and epoch); a newer task of the pool fences the older one -- whose self-check proves the loss (exit 3)
//      and whose next pool-fenced write is refused by the table; the survivor's graceful shutdown drains in order.
//   §2 a non-primary pool's task (LIVE-6 L6-1: it now serves routes -- its own suite is l6_1Routing.dynamoLocal): it takes
//      its pool and nothing else (no identity role is written).
//   §3 a generation that is not the ledger's: refused before the pool is taken (no POOL# item is written).
//   §4 with escrow (ESCROW-3B's offline chain, a KMS stand-in at the port): the ledger opened under the generation, the
//      relayer role taken (the ledger's fence minted, then the game-table mirror), the backend verified and loaded -- the
//      relayer's journal the DynamoDB ledger, its intents the DynamoDB stores.

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import { GetItemCommand, PutItemCommand, type AttributeValue, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { createDynamoDbClient, deadline, dynamoLocalTargetFromEnv, DYNAMODB_LOCAL_ENV } from "../../aws/awsClients";
import { poolKey, readHead } from "../../aws/game/gameTable";
import { readRelayerRole } from "../../aws/game/relayerRole";
import { readRouting, setPrimaryPool } from "../../aws/game/routing";
import { readIdentityRole } from "../../aws/identity/dynamoIdentityStore";
import { LEDGER_KEYS } from "../../aws/ledger/dynamoSigningLedger";
import { AwsStartupError, startAwsRuntime, type AwsRuntime } from "../../aws/runtime/awsRuntime";
import { realAwsSubstrate } from "../../aws/runtime/awsSubstrate";
import { AWS_RUNTIME_CONFIG_FORMAT, parseAwsRuntimeConfig } from "../../aws/runtime/runtimeConfig";
import { openJunoBackend } from "../../escrow/juno/junoBackend";
import { JUNO_BACKEND_CONFIG_FORMAT_V3, parseJunoBackendConfig, type JunoBackendConfig } from "../../escrow/juno/junoConfig";
import { bigIntTo32, decompressPublicKey, publicKeyOf, signDigest } from "../../escrow/juno/secp256k1";
import type { KmsClient } from "../../escrow/juno/signer";
import { ADMISSION_PUBKEY, ADMISSION_SECRET, CANONICAL_CHECKSUM, CHAIN_ID, CONTRACT, makeWorld, RELAYER_ADDRESS, RELAYER_SECRET, SETTLEMENT_SECRET } from "../../escrow/escrow3bSupport";
import { createMemoryOpsRecorder } from "../opsRecorder";
import { ALICE, BOB, quietConsole, seedGame } from "../../rooms/testSupport";
import { ConformanceTables, newRunId, requireLocal } from "./dynamoLocal";

const target = dynamoLocalTargetFromEnv();
if (target === null) {
  throw new Error(
    `${DYNAMODB_LOCAL_ENV} is not set. Start DynamoDB Local on this machine and point the suite at it, e.g.\n` +
      `  docker run --rm -p 127.0.0.1:8000:8000 amazon/dynamodb-local:3.3.1 -jar DynamoDBLocal.jar -inMemory\n` +
      `  ${DYNAMODB_LOCAL_ENV}=http://127.0.0.1:8000 npm run test:dynamodb-local\n` +
      "(server/src/aws/README.md has the Java route and the Windows PowerShell spelling).",
  );
}
const TARGET = target;
const admin: DynamoDBClient = createDynamoDbClient(TARGET);
const tables = new ConformanceTables(admin, newRunId());
const clients: DynamoDBClient[] = [];
const N = (value: number): AttributeValue => ({ N: String(value) });

quietConsole();

after(async () => {
  for (const client of clients) client.destroy();
  await tables.dropAll();
  assert.deepEqual(tables.live, [], "every table this run made was dropped");
  admin.destroy();
});

async function freshClient(): Promise<DynamoDBClient> {
  const client = createDynamoDbClient(TARGET);
  await requireLocal(client);
  clients.push(client);
  return client;
}

const LEDGER_ARN = "arn:aws:dynamodb:us-east-1:210987654321:table/gs-l57-ledger";
const KEY = (n: number) => `arn:aws:kms:us-east-1:123456789012:key/${String(n).repeat(8)}-1111-4111-8111-111111111111`;

interface Tables {
  readonly game: string;
  readonly identity: string;
  readonly ledger: string;
}

async function awsTables(label: string, generation = 1, primary: string | null = "p1"): Promise<Tables> {
  const game = await tables.create(`${label}-game`);
  const identity = await tables.create(`${label}-identity`);
  const ledger = await tables.create(`${label}-ledger`);
  await admin.send(new PutItemCommand({ TableName: ledger, Item: { ...LEDGER_KEYS.appgen(), schema: N(1), current_generation: N(generation) } }), { abortSignal: deadline() });
  if (primary !== null) {
    const routing = await readRouting(admin, game);
    const set = await setPrimaryPool(admin, game, { pool: primary, expectedVersion: routing?.routing_version ?? null, by: "pipeline", now: 1 });
    assert.equal(set.kind, "set");
  }
  return { game, identity, ledger };
}

const config = (over: Record<string, unknown> = {}) =>
  parseAwsRuntimeConfig({
    format: AWS_RUNTIME_CONFIG_FORMAT,
    environment: "local",
    region: "us-east-1",
    pool: "p1",
    generation: 1,
    game_table: "gs-l57-game-g1",
    identity_table: "gs-l57-identity",
    ledger_table_arn: LEDGER_ARN,
    escrow: null,
    ...over,
  });

const SPKI_PREFIX = Buffer.from("3056301006072a8648ce3d020106052b8104000a034200", "hex");
const spkiOf = (secret: Buffer) => {
  const { x, y } = decompressPublicKey(publicKeyOf(secret));
  return Buffer.concat([SPKI_PREFIX, Buffer.from([0x04]), bigIntTo32(x), bigIntTo32(y)]);
};
const derInteger = (value: Buffer) => {
  let body = value;
  while (body.length > 1 && body[0] === 0 && !(body[1] & 0x80)) body = body.subarray(1);
  if (body[0] & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  return Buffer.concat([Buffer.from([0x02, body.length]), body]);
};
const derOf = (compact: Buffer) => {
  const body = Buffer.concat([derInteger(compact.subarray(0, 32)), derInteger(compact.subarray(32))]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
};
const KEYS: Record<string, Buffer> = { [KEY(1)]: RELAYER_SECRET, [KEY(2)]: SETTLEMENT_SECRET, [KEY(3)]: ADMISSION_SECRET };
const kmsPort: KmsClient = {
  getPublicKey: async (ref) => spkiOf(KEYS[ref]),
  signDigest: async (ref, digest) => derOf(signDigest(KEYS[ref], Buffer.from(digest))),
};

function escrowConfig(): JunoBackendConfig {
  const parsed = parseJunoBackendConfig(
    {
      format: JUNO_BACKEND_CONFIG_FORMAT_V3,
      chain_id: CHAIN_ID,
      network_class: "testnet",
      rest_endpoints: ["https://rest.example"],
      contract_address: CONTRACT,
      code_checksum: CANONICAL_CHECKSUM,
      wasm_admin: null,
      denom: "ujunox",
      asset_symbol: "JUNOX",
      relayer: { address: RELAYER_ADDRESS, signer: { kind: "kms", key_ref: KEY(1) } },
      settlement_key: { signer_key_id: 1, public_key_hex: publicKeyOf(SETTLEMENT_SECRET).toString("hex"), signer: { kind: "kms", key_ref: KEY(2) } },
      admission_key: { public_key_hex: ADMISSION_PUBKEY, signer: { kind: "kms", key_ref: KEY(3) } },
      trust: { operators: [RELAYER_ADDRESS], resolvers: [RELAYER_ADDRESS], min_challenge_window_secs: "60", min_liveness_window_secs: "3600", min_resolver_timeout_secs: "3600" },
      journal: { kind: "dynamodb", table_arn: LEDGER_ARN },
    },
    { serverMode: "production", dataDir: "/nonexistent" },
  );
  return { ...parsed, trust: { ...parsed.trust, resolvers: ["juno1resolver"] } };
}

interface Started {
  readonly runtime: AwsRuntime;
  readonly exits: number[];
  readonly lines: string[];
}

async function start(t: Tables, task: string, over: { pool?: string; generation?: number; escrow?: boolean } = {}): Promise<Started> {
  const exits: number[] = [];
  const lines: string[] = [];
  const app = await freshClient();
  const ledger = await freshClient();
  const world = over.escrow === true ? makeWorld() : null;
  const runtime = await startAwsRuntime({
    config: config({ pool: over.pool ?? "p1", generation: over.generation ?? 1, ...(over.escrow === true ? { escrow: { config_parameter_arn: "arn:aws:ssm:us-east-1:123456789012:parameter/gs/l57/juno" } } : {}) }),
    escrowConfig: over.escrow === true ? escrowConfig() : null,
    server: { mode: "production", allowedOrigins: ["https://play.example"], trustedProxyHops: 1 },
    build: "l5-7-ddb",
    port: 0,
    bindHost: "127.0.0.1",
    moneySwitch: undefined,
    task,
    substrate: realAwsSubstrate({ config: config(), clients: { app, ledger }, tables: t, kms: () => kmsPort, timing: { maxResends: 2, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => undefined } }),
    ops: createMemoryOpsRecorder(),
    now: () => Date.now(),
    log: (line) => lines.push(line),
    warn: (line) => lines.push(line),
    error: (line) => lines.push(line),
    exit: (code) => exits.push(code),
    timing: { sweepEveryMs: 3_600_000, sweepRetryMs: 20, relayerRetryMs: 3_600_000, failFastDelayMs: 5, drainEscrowMs: 1_000, drainOwnershipMs: 1_000, drainChainFactsMs: 500, drainIdentityMs: 2_000 },
    ...(world !== null ? { openJunoBackend: (deps) => openJunoBackend({ ...deps, rest: world.chain, verifyEveryMs: 60_000 }) } : {}),
  });
  return { runtime, exits, lines };
}

async function until(predicate: () => boolean, label: string, ms = 8_000): Promise<void> {
  const deadlineAt = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadlineAt) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function readyz(runtime: AwsRuntime): Promise<{ status: number; body: Record<string, unknown> }> {
  const address = runtime.http.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: "/gs/readyz", timeout: 2_000 }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> }));
      })
      .on("error", reject);
  });
}

async function poolItem(game: string, pool: string): Promise<{ epoch: number; task: string } | null> {
  const answer = await admin.send(new GetItemCommand({ TableName: game, Key: poolKey(pool), ConsistentRead: true }), { abortSignal: deadline() });
  return answer.Item === undefined ? null : { epoch: Number(answer.Item.writer_epoch?.N), task: answer.Item.writer_task?.S ?? "" };
}

async function listening(runtime: AwsRuntime): Promise<void> {
  if (!runtime.http.listening) await new Promise((resolve) => runtime.http.once("listening", resolve));
}

/* ==================================================================
    §1 THE PRIMARY
   ================================================================== */
describe("§1 the primary on the real substrate", () => {
  test("pool, then the identity-writer role, then identity; the stores write under the pool writer's fence; a newer task fences the older (exit 3, its next write refused); the survivor drains in order", async () => {
    const t = await awsTables("primary");
    const a = await start(t, "t-a");
    let b: Started | null = null;
    try {
      assert.equal(a.runtime.role, "primary");
      assert.deepEqual(await poolItem(t.game, "p1"), { epoch: 1, task: "t-a" });
      const role = await readIdentityRole(admin, t.identity);
      assert.deepEqual({ epoch: role?.epoch, task: role?.task, pool: role?.pool }, { epoch: 1, task: "t-a", pool: "p1" }, "the identity-writer role, taken with the routing and pool conditions");
      await listening(a.runtime);
      const ready = await readyz(a.runtime);
      assert.equal(ready.status, 200, JSON.stringify(ready.body));
      assert.equal(ready.body.epoch, 1);

      /* The game stores carry the pool writer's fence: a record created through the server names p1 at epoch 1. */
      const gameId = await seedGame(a.runtime.server!.records, [ALICE, BOB], { dealt: false });
      const head = await readHead(admin, t.game, gameId);
      assert.deepEqual({ pool: head?.owner_pool, epoch: head?.pool_epoch }, { pool: "p1", epoch: 1 });
      await a.runtime.server!.lifecycle.loadGame(gameId); // the claim (idempotent: already this task's), then the load

      /* A newer task of the same pool: it takes the pool (epoch 2) and the identity role (epoch 2). */
      b = await start(t, "t-b");
      assert.deepEqual(await poolItem(t.game, "p1"), { epoch: 2, task: "t-b" });
      assert.equal((await readIdentityRole(admin, t.identity))?.epoch, 2);
      /* The older task's next pool-fenced write is refused BY THE TABLE, whatever it believes. */
      await assert.rejects(seedGame(a.runtime.server!.records, [ALICE, BOB]), /refused/);
      /* ... and its self-check proves the loss: exit 3, never a graceful drain. */
      await until(() => a.exits.length > 0, "the older task's loss");
      assert.deepEqual(a.exits, [3]);
      assert.equal(a.runtime.readiness().ready, false);
      await a.runtime.shutdown();
      assert.deepEqual([...a.runtime.shutdownSteps], []);

      /* The survivor serves, then shuts down gracefully, in the documented order. */
      await listening(b.runtime);
      assert.equal((await readyz(b.runtime)).status, 200);
      await b.runtime.shutdown();
      assert.deepEqual(
        [...b.runtime.shutdownSteps],
        ["readiness-503", "timers-stopped", "periodic-drained", "money-stopped", "relayer-stopped", "server-closed", "escrow-drained", "ownership-settled", "chain-facts-settled", "identity-settled", "pool-writer-stopped", "ops-flushed"],
      );
      assert.deepEqual(b.exits, []);
    } finally {
      await a.runtime.server?.close().catch(() => undefined);
      if (b !== null && b.runtime.shutdownSteps.length === 0) await b.runtime.shutdown();
    }
  });
});

/* ==================================================================
    §2 THE STANDBY, §3 THE GENERATION
   ================================================================== */
describe("§2 a non-primary pool's task, §3 a generation that is not the ledger's", () => {
  test("a non-primary task (LIVE-6 L6-1; L5-7's standby) takes its pool and NOTHING else: no identity-writer role is written; /gs/readyz 200 non-primary", async () => {
    const t = await awsTables("standby", 1, "p0");
    const s = await start(t, "t-s");
    try {
      assert.equal(s.runtime.role, "non-primary");
      assert.deepEqual(await poolItem(t.game, "p1"), { epoch: 1, task: "t-s" });
      assert.equal(await readIdentityRole(admin, t.identity), null, "no identity writer");
      await listening(s.runtime);
      const ready = await readyz(s.runtime);
      assert.equal(ready.status, 200, JSON.stringify(ready.body));
      assert.deepEqual([ready.body.role, ready.body.identity_writer, ready.body.identity], ["non-primary", "not-primary", "verifier"]);
    } finally {
      await s.runtime.shutdown();
    }
  });

  test("the ledger's adopted generation is not the task's: refused BEFORE the pool is taken (no POOL# item exists)", async () => {
    const t = await awsTables("generation", 2);
    await assert.rejects(start(t, "t-g"), (error: unknown) => error instanceof AwsStartupError && /adopted app generation is 2, not this task's 1/.test(error.message));
    assert.equal(await poolItem(t.game, "p1"), null, "nothing was fenced");
  });
});

/* ==================================================================
    §4 WITH ESCROW
   ================================================================== */
describe("§4 with escrow: the ledger, the relayer role and the backend on the real tables", () => {
  test("the ledger opened under the generation; the relayer role taken (fence minted, mirror written); the backend verified and loaded; the relayer's authority held", async () => {
    const t = await awsTables("escrow");
    const e = await start(t, "t-e", { escrow: true });
    try {
      assert.ok(e.runtime.steps.indexOf("identity-loaded") < e.runtime.steps.indexOf("ledger"));
      const fence = await admin.send(new GetItemCommand({ TableName: t.ledger, Key: LEDGER_KEYS.fence(RELAYER_ADDRESS), ConsistentRead: true }), { abortSignal: deadline() });
      assert.equal(fence.Item?.epoch?.N, "1", "the ledger's relayer fence was minted");
      const mirror = await readRelayerRole(admin, t.game, RELAYER_ADDRESS);
      assert.deepEqual({ epoch: mirror?.epoch, task: mirror?.task, pool: mirror?.pool }, { epoch: 1, task: "t-e", pool: "p1" }, "then the game-table mirror");
      await until(() => e.runtime.steps.includes("escrow-started"), "the backend's start");
      assert.equal(e.runtime.backend?.state(), "active", "verified on the offline chain, loaded over the DynamoDB stores and ledger");
      assert.equal(e.runtime.readiness().detail.relayer, "held");
      assert.equal(e.runtime.readiness().ready, true);
    } finally {
      await e.runtime.shutdown();
    }
  });
});
