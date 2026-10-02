/* LIVE-6 L6-6 (restore drill tooling): the old-generation fencing probe -- the ledger's own generation fence (never
 * committable), the KMS gate before KMS, and the PRODUCTION startup configured for the old generation -- over a fake
 * DynamoDB that evaluates the conditions it is sent. No AWS. */
import { strict as assert } from "assert";
import * as fs from "fs";
import * as path from "path";
import { describe, test } from "node:test";

import { GetItemCommand, TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";

import { FENCE_PROBE_REFUSED_EXIT, fenceProbeCommand, fenceProbeRecordFromLog, parseFenceProbeArgs, RESTORE_FENCE_PROBE_FORMAT, type FenceProbeArgs } from "../controlPlane/restoreFence";
import { generationConditionCheck } from "../ledger/dynamoSigningLedger";
import { realAwsSubstrate } from "./awsSubstrate";
import type { AwsStartup } from "./awsMain";
import { runRestoreFenceProbe, type FenceProbeDeps } from "./restoreFenceProbe";
import { parseAwsRuntimeConfigText } from "./runtimeConfig";

const REPO = path.resolve(__dirname, "../../../../../..");
const RUN = "l6restore-20261002x";
const ADOPTED_AT = Date.parse("2026-10-02T01:00:00Z");
const NOW = Date.parse("2026-10-02T01:20:00Z");
const TABLES = { game: "gs-staging-game-g2", identity: "gs-staging-identity", ledger: "gs-staging-ledger" };

function startupFor(generation: number, gameTable: string): AwsStartup {
  const doc = JSON.parse(fs.readFileSync(path.join(REPO, "infra/aws/fixtures/runtime-staging-p1-noescrow.json"), "utf8"));
  return { config: parseAwsRuntimeConfigText(JSON.stringify({ ...doc, generation, game_table: gameTable })), configVersion: 3, escrowConfig: null, escrowConfigVersion: null };
}

type Item = Record<string, { S?: string; N?: string }>;

/** A DynamoDB that holds APPGEN and evaluates exactly the conditions the probe sends (the fence term and the guard). */
function fakeDynamo(appgen: Item | null, options: { readonly brokenFence?: boolean } = {}) {
  const sent: Array<{ readonly kind: string; readonly input: any }> = [];
  const client = {
    async send(command: unknown) {
      if (command instanceof GetItemCommand) {
        sent.push({ kind: "GetItem", input: command.input });
        const key = command.input.Key as Item;
        if (key.pk?.S === "APPGEN" && key.sk?.S === "APPGEN") return { Item: appgen ?? undefined };
        return {};
      }
      if (command instanceof TransactWriteItemsCommand) {
        sent.push({ kind: "TransactWriteItems", input: command.input });
        const items = command.input.TransactItems ?? [];
        const codes = items.map((item: any) => {
          if (item.ConditionCheck !== undefined) {
            const want = item.ConditionCheck.ExpressionAttributeValues[":gen"].N;
            const holds = appgen !== null && appgen.schema?.N === "1" && appgen.current_generation?.N === want;
            return holds || options.brokenFence === true ? "None" : "ConditionalCheckFailed";
          }
          if (item.Put !== undefined) return item.Put.ConditionExpression === "attribute_exists(#pk)" ? "ConditionalCheckFailed" : "None";
          return "ValidationError";
        });
        if (codes.some((c: string) => c !== "None")) throw Object.assign(new Error("Transaction cancelled"), { name: "TransactionCanceledException", CancellationReasons: codes.map((Code: string) => ({ Code })) });
        return {};
      }
      throw new Error(`fake dynamo: unexpected ${String((command as { constructor: { name: string } }).constructor.name)}`);
    },
  };
  return { client: client as never, sent };
}

const ADOPTED: Item = { pk: { S: "APPGEN" }, sk: { S: "APPGEN" }, schema: { N: "1" }, current_generation: { N: "2" }, previous_generation: { N: "1" }, adopted_at: { N: String(ADOPTED_AT) }, adopted_by: { S: "op" }, restore_id: { S: "drill-1002" }, game_table: { S: "gs-staging-game-g2" }, claim: { S: "22222222-2222-4222-8222-222222222222" } };
const BOOTSTRAP: Item = { pk: { S: "APPGEN" }, sk: { S: "APPGEN" }, schema: { N: "1" }, current_generation: { N: "1" } };

const args = (mode: FenceProbeArgs["mode"], over: Partial<FenceProbeArgs> = {}): FenceProbeArgs => ({ mode, run: RUN, environment: "staging", pool: "p1", previousGeneration: 1, generation: 2, restoreId: "drill-1002", oldGameTable: "gs-staging-game-g1", ...over });

async function probe(mode: FenceProbeArgs["mode"], appgen: Item | null, over: { readonly args?: Partial<FenceProbeArgs>; readonly startup?: AwsStartup; readonly brokenFence?: boolean } = {}) {
  const dynamo = fakeDynamo(appgen, { brokenFence: over.brokenFence });
  const lines: string[] = [];
  const deps: FenceProbeDeps = {
    env: { BUILD_ID: "2026-10-02-test", GS_AWS_CONFIG_PARAMETER: "arn:aws:ssm:us-east-1:111111111111:parameter/gs/staging/runtime/p1" },
    now: () => NOW,
    out: (line) => lines.push(line),
    loadStartup: async () => over.startup ?? startupFor(2, "gs-staging-game-g2"),
    clients: () => ({ app: dynamo.client, ledger: dynamo.client }),
    substrate: (config, clients, tables) => realAwsSubstrate({ config, clients, tables }),
    tables: () => TABLES,
    taskArn: async () => "arn:aws:ecs:us-east-1:111111111111:task/gs-staging/f1f10000000000000000000000000000",
  };
  const argv = fenceProbeCommand(args(mode, over.args)).slice(2);
  const exit = await runRestoreFenceProbe(argv, deps);
  const got = fenceProbeRecordFromLog(lines);
  assert.ok(got.ok, JSON.stringify(got));
  return { exit, record: (got as { record: any }).record, sent: dynamo.sent, lines };
}

describe("restore fencing probe: the old generation exercised through the production fences, after adoption", () => {
  test("ledger-kms: the ledger's OWN generation term for the old generation, refused; the control passes it; the never-committable guard; KMS never called", async () => {
    const { exit, record, sent } = await probe("ledger-kms", ADOPTED);
    assert.equal(exit, 0);
    assert.equal(record.format, RESTORE_FENCE_PROBE_FORMAT);
    assert.equal(record.refused, null);
    assert.deepEqual(record.adoption, { restore_id: "drill-1002", previous_generation: 1, generation: 2, game_table: "gs-staging-game-g2", adopted_at: ADOPTED_AT });
    const ledger = record.cases["old-generation-ledger-write-refused"];
    assert.deepEqual([ledger.generation, ledger.outcome, ledger.fence], [1, "fenced", "generation"]);
    assert.deepEqual(ledger.evidence.old.codes, ["ConditionalCheckFailed", "ConditionalCheckFailed"]);
    assert.deepEqual(ledger.evidence.control.codes, ["None", "ConditionalCheckFailed"]);
    assert.equal(ledger.evidence.written, false);
    const writes = sent.filter((s) => s.kind === "TransactWriteItems");
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[0].input.TransactItems[0], generationConditionCheck(TABLES.ledger, 1), "exactly the term every ledger write of generation 1 carries");
    assert.deepEqual(writes[1].input.TransactItems[0], generationConditionCheck(TABLES.ledger, 2));
    for (const w of writes) {
      assert.equal(w.input.TransactItems.length, 2);
      assert.equal(w.input.TransactItems[1].Put.ConditionExpression, "attribute_exists(#pk)", "the guard can never hold: nothing is ever written");
      assert.equal(w.input.TransactItems[1].Put.Item.pk.S, `L6CERT#${RUN}`);
    }
    const kms = record.cases["kms-side-effect-withheld"];
    assert.deepEqual([kms.generation, kms.kms_sign_calls, kms.outcome], [1, 0, "withheld"]);
    assert.deepEqual([kms.evidence.gate, kms.evidence.withheld_counter, kms.evidence.signs_counter, kms.evidence.error_code, kms.evidence.native, kms.evidence.signature_may_exist], ["generation", 1, 0, "unavailable", "PoolWriterNotCurrent", false]);
    assert.match(kms.evidence.gate_detail, /the adopted generation is 2, not this task's 1/);
  });

  test("ledger: a fence that did not hold is recorded as what it was -- never 'fenced'", async () => {
    const { record } = await probe("ledger-kms", ADOPTED, { brokenFence: true });
    const ledger = record.cases["old-generation-ledger-write-refused"];
    assert.equal(ledger.outcome, "not-fenced");
    assert.equal(ledger.fence, null);
    assert.equal(ledger.evidence.written, false, "the guard still refused the transaction: nothing was written");
  });

  test("old-task: the PRODUCTION startup configured for the old generation is refused for the generation, before the pool -- exit 2, never ready", async () => {
    const { exit, record, sent } = await probe("old-task", ADOPTED);
    assert.equal(exit, 2, "the task exits with the runtime's own exit code");
    const c = record.cases["old-generation-task-never-ready"];
    assert.deepEqual([c.generation, c.game_table, c.ready, c.exit_code, c.reason], [1, "gs-staging-game-g1", false, 2, "generation"]);
    assert.deepEqual(c.evidence.boundary_calls, [], "nothing past the generation reads: no pool was taken");
    assert.equal(c.evidence.runtime_started, false);
    assert.equal(c.evidence.startup_error, "AwsStartupError");
    assert.deepEqual(c.evidence.metrics, { StartupRefused: 1, StartupRefusedGeneration: 1 }, "the runtime's own refusal record (captured, never printed as EMF)");
    assert.ok(sent.every((s) => s.kind === "GetItem"), "the old task only READ");
    assert.equal(record.cases["old-generation-ledger-write-refused"], undefined);
  });

  test("before anything: not after THIS adoption -> refused (exit 9), no fence exercised", async () => {
    const cases: Array<[Item | null, Parameters<typeof probe>[2], RegExp]> = [
      [BOOTSTRAP, {}, /no adoption/],
      [null, {}, /no adoption/],
      [{ ...ADOPTED, restore_id: { S: "drill-other" } }, {}, /not 1 -> 2 .* restore drill-1002/],
      [ADOPTED, { args: { previousGeneration: 1, generation: 3 } }, /serves generation 2, not the adopted 3/],
      [ADOPTED, { startup: startupFor(1, "gs-staging-game-g1") }, /serves generation 1, not the adopted 2/],
      [ADOPTED, { args: { pool: "p2" } }, /staging\/p1, not staging\/p2/],
    ];
    for (const [appgen, over, why] of cases) {
      for (const mode of ["ledger-kms", "old-task"] as const) {
        const { exit, record, sent } = await probe(mode, appgen, over);
        assert.equal(exit, FENCE_PROBE_REFUSED_EXIT, `${mode} ${why}`);
        assert.match(String(record.refused), why);
        assert.deepEqual(record.cases, {});
        assert.ok(sent.every((s) => s.kind === "GetItem"), "nothing but reads before a refusal");
      }
    }
  });

  test("the command and its argv are one contract: exact flags, non-prod only, M > N", () => {
    const argv = fenceProbeCommand(args("old-task"));
    assert.deepEqual(argv.slice(0, 2), ["node", "dist/server/src/aws/runtime/restoreFenceProbe.js"]);
    assert.deepEqual(parseFenceProbeArgs(argv.slice(2)), args("old-task"));
    assert.throws(() => fenceProbeCommand(args("old-task", { environment: "prod" })), /non-prod/);
    assert.throws(() => fenceProbeCommand(args("old-task", { generation: 1 })), /M > N/);
    assert.match(String((parseFenceProbeArgs([...argv.slice(2), "--apply", "x"]) as { problem: string }).problem), /unexpected argument/);
    assert.ok(fs.existsSync(path.join(__dirname, "restoreFenceProbe.js")), "the compiled entry the command names exists in this build");
  });
});
