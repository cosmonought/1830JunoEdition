// server/src/persistence/conformance/awsBootstrap.dynamoLocal.test.ts
//
// ==================================================================
//  LIVE-5 L5-8: THE FIRST-START BOOTSTRAP (APPGEN + SYSTEM/ROUTING) -- ON DYNAMODB LOCAL, THROUGH THE COMMAND ITSELF
// ==================================================================
//
// Runs ONLY against a DynamoDB Local named by GS_DYNAMODB_LOCAL_ENDPOINT (`npm run test:dynamodb-local`); without one it
// FAILS with instructions. Each case drives `awsDeploy bootstrap` (`aws/deploy/commands.ts`) with the runtime document
// served by a fake SSM source and the tables on DynamoDB Local, and reads the tables back with the RUNTIME's own strict
// readers (`readAdoptedGeneration`, `readRouting`):
//   - a dry run writes nothing; --apply creates exactly the two records the runtime needs; --check agrees;
//   - a second --apply is a no-op (bytes unchanged: the routing's claim and time are not re-stamped);
//   - an incompatible or unreadable record -- either one -- refuses the WHOLE bootstrap: nothing at all is written, and a
//     generation or routing is never reset;
//   - a mis-pointed runtime document (environment, pool, generation) refuses before anything is read;
//   - a lost answer is settled by reading back; a write that was never sent is UNKNOWN (exit 3) and the same command
//     completes it.

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { PutItemCommand, ScanCommand, type AttributeValue, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { createDynamoDbClient, deadline, dynamoLocalTargetFromEnv, DYNAMODB_LOCAL_ENV } from "../../aws/awsClients";
import { runDeployCommand, EXIT_FAILED, EXIT_OK, EXIT_UNKNOWN, EXIT_USAGE, type DeployDeps } from "../../aws/deploy/commands";
import { readRouting, setPrimaryPool } from "../../aws/game/routing";
import { LEDGER_KEYS, readAdoptedGeneration } from "../../aws/ledger/dynamoSigningLedger";
import type { ParameterSource } from "../../aws/runtime/configSource";
import { FaultScript } from "./faults";
import { ConformanceTables, installFaults, newRunId, requireLocal } from "./dynamoLocal";

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

after(async () => {
  for (const client of clients) client.destroy();
  await tables.dropAll();
  assert.deepEqual(tables.live, [], "every table this run made was dropped");
  admin.destroy();
});

const ENV = "l58test";
const RUNTIME_ARN = `arn:aws:ssm:us-east-1:111111111111:parameter/gs/${ENV}/runtime/p1`;
const LEDGER_ARN = `arn:aws:dynamodb:us-east-1:222222222222:table/gs-${ENV}-ledger`;

const runtimeDocument = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    format: "18COSMOS/AWS-RUNTIME/v1",
    environment: ENV,
    region: "us-east-1",
    pool: "p1",
    generation: 1,
    game_table: `gs-${ENV}-game-g1`,
    identity_table: `gs-${ENV}-identity`,
    ledger_table_arn: LEDGER_ARN,
    escrow: null,
    ...overrides,
  });

interface Bench {
  readonly game: string;
  readonly ledger: string;
  readonly client: DynamoDBClient;
  readonly faults: FaultScript;
  readonly lines: string[];
  run(...argv: string[]): Promise<number>;
}

async function bench(label: string, document = runtimeDocument()): Promise<Bench> {
  const game = await tables.create(`${label}-game`);
  const ledger = await tables.create(`${label}-ledger`);
  const client = createDynamoDbClient(TARGET);
  await requireLocal(client);
  clients.push(client);
  const faults = new FaultScript();
  installFaults(client, faults);
  const lines: string[] = [];
  const parameters: ParameterSource = {
    async read(arn) {
      if (arn !== RUNTIME_ARN) throw new Error(`no such parameter ${arn}`);
      return { value: document, version: 7, arn };
    },
  };
  const deps: DeployDeps = {
    parameters,
    dynamo: () => client,
    kms: () => {
      throw new Error("no KMS in this suite");
    },
    now: () => 1_790_000_000_000,
    out: (line) => lines.push(line),
    tables: () => ({ game, identity: `${game}-unused`, ledger }),
  };
  return { game, ledger, client, faults, lines, run: (...argv) => runDeployCommand(argv, deps) };
}

const BOOTSTRAP = ["bootstrap", "--runtime-parameter", RUNTIME_ARN, "--environment", ENV, "--primary-pool", "p1", "--generation", "1", "--by", "pipeline-run-42"];

async function items(table: string): Promise<Array<Record<string, AttributeValue>>> {
  const answer = await admin.send(new ScanCommand({ TableName: table, ConsistentRead: true }), { abortSignal: deadline() });
  return (answer.Items ?? []).sort((a, b) => `${a.pk?.S}/${a.sk?.S}`.localeCompare(`${b.pk?.S}/${b.sk?.S}`));
}

describe("L5-8 bootstrap: the first start's two records, created once", () => {
  test("a dry run reads and writes nothing; --apply creates exactly APPGEN and SYSTEM/ROUTING; --check agrees", async () => {
    const b = await bench("fresh");
    assert.equal(await b.run(...BOOTSTRAP, "--check"), EXIT_FAILED, "not bootstrapped yet");
    assert.equal(await b.run(...BOOTSTRAP), EXIT_OK, b.lines.join("\n"));
    assert.ok(b.lines.some((l) => l.includes("DRY RUN: --apply would create APPGEN (create-if-absent) and SYSTEM/ROUTING")), b.lines.join("\n"));
    assert.deepEqual(await items(b.game), [], "the dry run wrote nothing to the game table");
    assert.deepEqual(await items(b.ledger), [], "the dry run wrote nothing to the ledger");

    assert.equal(await b.run(...BOOTSTRAP, "--apply"), EXIT_OK, b.lines.join("\n"));
    assert.ok(b.lines.some((l) => l === "BOOTSTRAPPED: APPGEN created, SYSTEM/ROUTING created"), b.lines.join("\n"));
    assert.deepEqual(await items(b.ledger), [{ ...LEDGER_KEYS.appgen(), schema: { N: "1" }, current_generation: { N: "1" } }], "APPGEN is exactly {schema 1, current_generation 1}");
    assert.equal(await readAdoptedGeneration(b.client, b.ledger), 1, "the runtime's strict reader reads it");
    const routing = await readRouting(b.client, b.game);
    assert.equal(routing?.primary_pool, "p1");
    assert.equal(routing?.routing_version, 1);
    assert.equal(routing?.updated_by, "pipeline-run-42");
    assert.equal((await items(b.game)).length, 1, "only SYSTEM/ROUTING (POOL# and roles are the first task's)");
    assert.equal(await b.run(...BOOTSTRAP, "--check"), EXIT_OK);
    assert.ok(b.lines.every((l) => !/secret|password|AKIA/i.test(l)), "nothing secret-shaped is printed");
  });

  test("idempotent: a second --apply writes nothing (the routing is not re-stamped)", async () => {
    const b = await bench("again");
    assert.equal(await b.run(...BOOTSTRAP, "--apply"), EXIT_OK);
    const before = { game: await items(b.game), ledger: await items(b.ledger) };
    assert.equal(await b.run(...BOOTSTRAP, "--apply"), EXIT_OK, b.lines.join("\n"));
    assert.ok(b.lines.some((l) => l === "BOOTSTRAPPED: APPGEN matched, SYSTEM/ROUTING matched"));
    assert.deepEqual({ game: await items(b.game), ledger: await items(b.ledger) }, before, "byte-identical");
    assert.equal(b.faults.count("PutItemCommand"), 2, "the second run sent no write at all");
  });

  test("a routing naming another pool refuses the whole bootstrap: APPGEN is not created either, the routing is untouched", async () => {
    const b = await bench("foreign-routing");
    assert.deepEqual(await setPrimaryPool(admin, b.game, { pool: "p2", expectedVersion: null, by: "operator", now: 5 }), { kind: "set", routing: (await readRouting(admin, b.game))! });
    const routingBefore = await items(b.game);
    assert.equal(await b.run(...BOOTSTRAP, "--apply"), EXIT_FAILED, b.lines.join("\n"));
    assert.ok(b.lines.some((l) => l.includes("REFUSED: SYSTEM/ROUTING: SYSTEM/ROUTING already names primary_pool p2")), b.lines.join("\n"));
    assert.deepEqual(await items(b.ledger), [], "nothing was written: APPGEN is not created beside a refused routing");
    assert.deepEqual(await items(b.game), routingBefore, "the routing is never overwritten (a flip is L6-2's)");
    assert.equal(await b.run(...BOOTSTRAP), EXIT_FAILED, "the dry run says the same");
  });

  test("an APPGEN at another generation refuses the whole bootstrap: never reset, and no routing is created", async () => {
    const b = await bench("other-generation");
    await admin.send(new PutItemCommand({ TableName: b.ledger, Item: { ...LEDGER_KEYS.appgen(), schema: { N: "1" }, current_generation: { N: "2" } } }), { abortSignal: deadline() });
    assert.equal(await b.run(...BOOTSTRAP, "--apply"), EXIT_FAILED, b.lines.join("\n"));
    assert.ok(b.lines.some((l) => l.includes("APPGEN already holds generation 2, not 1")), b.lines.join("\n"));
    assert.equal(await readAdoptedGeneration(admin, b.ledger), 2, "the generation is never reset");
    assert.deepEqual(await items(b.game), [], "no routing is created beside a refused APPGEN");
  });

  test("an unreadable APPGEN or routing refuses (never overwritten, never read as absent)", async () => {
    const newer = await bench("newer-appgen");
    await admin.send(new PutItemCommand({ TableName: newer.ledger, Item: { ...LEDGER_KEYS.appgen(), schema: { N: "2" }, current_generation: { N: "1" } } }), { abortSignal: deadline() });
    const ledgerBefore = await items(newer.ledger);
    assert.equal(await newer.run(...BOOTSTRAP, "--apply"), EXIT_FAILED, newer.lines.join("\n"));
    assert.ok(newer.lines.some((l) => l.includes("APPGEN: unreadable")), newer.lines.join("\n"));
    assert.deepEqual(await items(newer.ledger), ledgerBefore);
    assert.deepEqual(await items(newer.game), []);

    const damaged = await bench("damaged-routing");
    await admin.send(new PutItemCommand({ TableName: damaged.game, Item: { pk: { S: "SYSTEM" }, sk: { S: "ROUTING" }, fmt: { N: "1" }, primary_pool: { S: "p1" } } }), { abortSignal: deadline() });
    const gameBefore = await items(damaged.game);
    assert.equal(await damaged.run(...BOOTSTRAP, "--apply"), EXIT_FAILED, damaged.lines.join("\n"));
    assert.ok(damaged.lines.some((l) => l.includes("SYSTEM/ROUTING: unreadable")), damaged.lines.join("\n"));
    assert.deepEqual(await items(damaged.game), gameBefore, "a damaged routing is never overwritten -- even one that names the right pool");
    assert.deepEqual(await items(damaged.ledger), []);
  });

  test("explicit about what it is for: a runtime document for another environment, pool or generation refuses before anything is read", async () => {
    const b = await bench("mispointed");
    const variants: Array<[string[], RegExp]> = [
      [["--environment", "prod"], /the document is for l58test, not prod/],
      [["--generation", "2"], /the document is for generation 1, not 2/],
      [["--primary-pool", "p2"], /the document is pool p1's, not p2's/],
    ];
    for (const [change, reason] of variants) {
      const argv = [...BOOTSTRAP];
      argv[argv.indexOf(change[0]) + 1] = change[1];
      b.lines.length = 0;
      assert.equal(await b.run(...argv, "--apply"), EXIT_USAGE, change.join(" "));
      assert.ok(b.lines.some((l) => reason.test(l)), b.lines.join("\n"));
    }
    assert.equal(b.faults.calls.length, 0, "not one DynamoDB call was made");
    const wrongName = await bench("wrong-table-name", runtimeDocument({ game_table: "gs-prod-game-g1" }));
    assert.equal(await wrongName.run(...BOOTSTRAP, "--apply"), EXIT_USAGE);
    assert.ok(wrongName.lines.some((l) => /gs-prod-game-g1 is not gs-l58test-game-g1/.test(l)), wrongName.lines.join("\n"));
    assert.equal(await b.run("bootstrap", "--runtime-parameter", RUNTIME_ARN, "--environment", ENV), EXIT_USAGE, "every flag is required");
  });

  test("a lost answer is settled by reading back; a write never sent is UNKNOWN (exit 3) and the same command completes it", async () => {
    const lost = await bench("lost-answer");
    lost.faults.add({ op: "PutItemCommand", where: (d) => d.includes('"APPGEN"'), action: { kind: "lose-answer" }, label: "APPGEN lands, its answer is lost" });
    lost.faults.add({ op: "PutItemCommand", where: (d) => d.includes('"ROUTING"'), action: { kind: "lose-answer" }, label: "the routing lands, its answer is lost" });
    assert.equal(await lost.run(...BOOTSTRAP, "--apply"), EXIT_OK, lost.lines.join("\n"));
    assert.deepEqual(lost.faults.unfired(), []);
    assert.equal(await readAdoptedGeneration(admin, lost.ledger), 1);
    assert.equal((await readRouting(admin, lost.game))?.primary_pool, "p1");

    const unsent = await bench("unsent");
    unsent.faults.add({ op: "PutItemCommand", where: (d) => d.includes('"APPGEN"'), action: { kind: "fail", code: "TimeoutError" }, label: "APPGEN never sent" });
    assert.equal(await unsent.run(...BOOTSTRAP, "--apply"), EXIT_UNKNOWN, unsent.lines.join("\n"));
    assert.ok(unsent.lines.some((l) => l.startsWith("UNKNOWN: APPGEN")), unsent.lines.join("\n"));
    assert.deepEqual(await items(unsent.ledger), []);
    assert.deepEqual(await items(unsent.game), [], "the routing is not written after an unsettled APPGEN");
    assert.equal(await unsent.run(...BOOTSTRAP, "--apply"), EXIT_OK, "the same command, again");
    assert.equal(await readAdoptedGeneration(admin, unsent.ledger), 1);

    const routingUnsent = await bench("routing-unsent");
    routingUnsent.faults.add({ op: "PutItemCommand", where: (d) => d.includes('"ROUTING"'), action: { kind: "fail", code: "TimeoutError" }, label: "the routing never sent" });
    assert.equal(await routingUnsent.run(...BOOTSTRAP, "--apply"), EXIT_UNKNOWN, routingUnsent.lines.join("\n"));
    assert.equal(await readAdoptedGeneration(admin, routingUnsent.ledger), 1, "APPGEN (first) is in place");
    assert.equal(await readRouting(admin, routingUnsent.game), null);
    assert.equal(await routingUnsent.run(...BOOTSTRAP, "--apply"), EXIT_OK);
    assert.ok(routingUnsent.lines.some((l) => l === "BOOTSTRAPPED: APPGEN matched, SYSTEM/ROUTING created"), routingUnsent.lines.join("\n"));
  });

  test("the verifier's control-record checks read the bootstrap's records as the runtime would", async () => {
    const b = await bench("verify-records");
    assert.equal(await b.run(...BOOTSTRAP, "--apply"), EXIT_OK);
    b.lines.length = 0;
    /* The ledger half (APPGEN) as the ledger account runs it; the table checks fail here only because DynamoDB Local's
       tables are not named by the convention and lack deletion protection -- the record check is what this case is for. */
    await b.run("verify", "--part", "ledger", "--ledger-table-arn", LEDGER_ARN, "--environment", ENV, "--generation", "1");
    assert.ok(b.lines.some((l) => l.startsWith("PASS  APPGEN -- APPGEN current_generation 1")), b.lines.join("\n"));
  });
});
