// server/src/persistence/conformance/l6RestoreDrill.test.ts
//
// LIVE-6 L6-6 (restore drill tooling): END TO END across the layers the import guard keeps apart (no AWS):
//   fencing      the REAL in-task probe (aws/runtime/restoreFenceProbe.ts, the production startup and fences over a fake
//                DynamoDB) prints its line; the producer (aws/deploy/staging/restoreFencing.ts) reads exactly that line back
//                from the task's log capture, binds it to ECS's record and the adoption, and the UNCHANGED
//                judgeRestoreFencing passes the record.
//   alarms       the REAL probe program (RESTORE_PROBE_PROGRAM, run as node -e over the compiled encoder) writes its EMF line;
//                that very line, as the task's log capture, derives the case.
//   overlap      the REAL operator command (aws/operator/suppressionOverlap.ts) opens and closes the staging flip-suppression
//                test through L6-5B's applySuppression -- +1 datapoints for exactly two pools, -1 for the minutes left --
//                reading SYSTEM/ROUTING and never writing it; its record is what the restore alarm producer reads.

import { strict as assert } from "assert";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { describe, test } from "node:test";

import { GetItemCommand, TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";

import { FLIP_SUPPRESSION, type SuppressionDatum } from "../../aws/controlPlane/flipSuppression";
import { fenceProbeCommand } from "../../aws/controlPlane/restoreFence";
import { judgeRestoreFencing, readGenerationEvidence, RESTORE_FENCING_FILE, type RecoveryReaders } from "../../aws/deploy/staging/recovery";
import { deriveRestoreCase, RESTORE_ALARM_FILES, RESTORE_PROBE_PROGRAM, suppressionRecordOf } from "../../aws/deploy/staging/restoreAlarmProbe";
import { ADOPTION, cleanup, ENV, FENCE_POOL, RUN, RUNTIME_ARN, SCRIPTS, taskArnOf, tempDir, writeCase, writeDeploymentCapture, writeFenceProbes } from "../../aws/deploy/staging/restoreDrillFixtures.test";
import { recordRestoreFencing } from "../../aws/deploy/staging/restoreFencing";
import { closeSuppressionOverlap, openSuppressionOverlap, type OverlapDeps } from "../../aws/operator/suppressionOverlap";
import { realAwsSubstrate } from "../../aws/runtime/awsSubstrate";
import { runRestoreFenceProbe } from "../../aws/runtime/restoreFenceProbe";
import { parseAwsRuntimeConfigText } from "../../aws/runtime/runtimeConfig";

const REPO = path.resolve(__dirname, "../../../../../..");
const METRICS_MODULE = path.join(__dirname, "..", "..", "aws", "runtime", "runtimeMetrics.js");

function fakeLedger() {
  const appgen = { pk: { S: "APPGEN" }, sk: { S: "APPGEN" }, schema: { N: "1" }, current_generation: { N: "2" }, previous_generation: { N: "1" }, adopted_at: { N: String(ADOPTION.adopted_at) }, adopted_by: { S: "op" }, restore_id: { S: ADOPTION.restore_id }, game_table: { S: ADOPTION.game_table }, claim: { S: "22222222-2222-4222-8222-222222222222" } };
  return {
    async send(command: unknown) {
      if (command instanceof GetItemCommand) return (command.input.Key as any).pk?.S === "APPGEN" ? { Item: appgen } : {};
      if (command instanceof TransactWriteItemsCommand) {
        const codes = (command.input.TransactItems ?? []).map((i: any) => (i.ConditionCheck !== undefined ? (i.ConditionCheck.ExpressionAttributeValues[":gen"].N === "2" ? "None" : "ConditionalCheckFailed") : "ConditionalCheckFailed"));
        throw Object.assign(new Error("cancelled"), { name: "TransactionCanceledException", CancellationReasons: codes.map((Code: string) => ({ Code })) });
      }
      throw new Error("unexpected");
    },
  } as never;
}

describe("LIVE-6 restore drill tooling, end to end across the layers", () => {
  test("fencing: the real in-task probe's own lines -> the producer -> the UNCHANGED judgeRestoreFencing passes", async () => {
    const doc = JSON.parse(fs.readFileSync(path.join(REPO, "infra/aws/fixtures/runtime-staging-p1-noescrow.json"), "utf8"));
    const config = parseAwsRuntimeConfigText(JSON.stringify({ ...doc, pool: FENCE_POOL, generation: 2, game_table: ADOPTION.game_table, routes: { [FENCE_POOL]: { ws_path: `/gs/p/${FENCE_POOL}` } } }));
    const lines: Record<string, string[]> = { "ledger-kms": [], "old-task": [] };
    const exits: Record<string, number> = {};
    for (const mode of ["ledger-kms", "old-task"] as const) {
      const ledger = fakeLedger();
      exits[mode] = await runRestoreFenceProbe(fenceProbeCommand({ mode, run: RUN, environment: ENV, pool: FENCE_POOL, previousGeneration: 1, generation: 2, restoreId: ADOPTION.restore_id, oldGameTable: `gs-${ENV}-game-g1` }).slice(2), {
        env: { BUILD_ID: "2026-10-02-test", GS_AWS_CONFIG_PARAMETER: RUNTIME_ARN(FENCE_POOL) },
        now: () => Date.parse("2026-10-02T01:20:00Z"),
        out: (line) => lines[mode].push(line),
        loadStartup: async () => ({ config, configVersion: 3, escrowConfig: null, escrowConfigVersion: null }),
        clients: () => ({ app: ledger, ledger }),
        substrate: (c, clients, tables) => realAwsSubstrate({ config: c, clients, tables }),
        tables: () => ({ game: ADOPTION.game_table, identity: "gs-staging-identity", ledger: "gs-staging-ledger" }),
        taskArn: async () => taskArnOf(mode === "ledger-kms" ? "f1f1" : "f2f2"),
      });
    }
    assert.deepEqual(exits, { "ledger-kms": 0, "old-task": 2 }, "ECS sees the runtime's own exit for the old task");
    const dir = tempDir("gs-l6rd-");
    try {
      writeFenceProbes(dir, { "ledger-kms": { lines: lines["ledger-kms"] }, "old-task": { lines: lines["old-task"] } });
      writeDeploymentCapture(dir);
      const readers: RecoveryReaders = {
        generationMarker: async () => null,
        appGeneration: async () => ({ current_generation: 2, adoption: { previous_generation: 1, adopted_at: ADOPTION.adopted_at, adopted_by: "op", restore_id: ADOPTION.restore_id, game_table: ADOPTION.game_table, claim: "22222222-2222-4222-8222-222222222222" } }),
        generationServingProblem: () => null,
        identityState: async () => ({ restore: null, self: null, servingProblem: null }),
        reviews: async () => [],
        adoptionRecord: async () => null,
      };
      const generation = await readGenerationEvidence(readers, { app: {} as never, ledger: {} as never }, { game: ADOPTION.game_table, ledger: "gs-staging-ledger" });
      const v = recordRestoreFencing(dir, { run: RUN, environment: ENV, primaryPool: "p1", runtimeParameter: RUNTIME_ARN("p1"), configGeneration: 2, configGameTable: ADOPTION.game_table, generation });
      assert.equal(v.kind, "observed", JSON.stringify(v));
      const adoption = { ...ADOPTION, adopted_by: "op", claim: "22222222-2222-4222-8222-222222222222" };
      assert.ok(judgeRestoreFencing(dir, { run: RUN, adoption }).every((c) => c.status === "pass"));
      const rec = JSON.parse(fs.readFileSync(path.join(dir, RESTORE_FENCING_FILE), "utf8"));
      assert.equal(rec.cases["old-generation-ledger-write-refused"].fence, "generation");
      assert.equal(rec.cases["kms-side-effect-withheld"].kms_sign_calls, 0);
      assert.equal(rec.cases["old-generation-task-never-ready"].reason, "generation");
    } finally {
      cleanup(dir);
    }
  });

  test("alarms: the real probe program's own EMF line, as the task's log capture, derives the case", () => {
    const run = spawnSync(process.execPath, ["-e", RESTORE_PROBE_PROGRAM], { env: { ...process.env, RA_METRICS_MODULE: METRICS_MODULE, RA_CASE: "a4i", RA_ENVIRONMENT: ENV, RA_POOL: "p2", RA_RUN: RUN }, encoding: "utf8", timeout: 20_000 });
    assert.equal(run.status, 0, run.stderr);
    const lines = run.stdout.split("\n").filter((l) => l !== "");
    const emfAt = (JSON.parse(lines.find((l) => l.startsWith("{")) as string) as { _aws: { Timestamp: number } })._aws.Timestamp;
    const dir = tempDir("gs-l6rd-");
    try {
      writeCase(dir, { ...SCRIPTS.a4i, pre: emfAt - 60_000, emf: [], started: emfAt - 2000, stopped: emfAt + 3000, history: [{ at: emfAt + 70_000, to: "ALARM" }], post: emfAt + 120_000 }, { log: { events: lines.map((message) => ({ message })) } });
      const v = deriveRestoreCase({ dir, run: RUN, environment: ENV }, "a4i");
      assert.equal(v.kind, "observed", JSON.stringify(v));
      assert.equal((v as any).value.injected_at, emfAt);
      assert.deepEqual((v as any).value.injection.metrics, ["StartupRefused", "StartupRefusedIdentityRestore"], "the decision's own set: the companion A4 counter rides with A4i, exactly as in the runtime");
    } finally {
      cleanup(dir);
    }
  });

  test("overlap: the real operator command publishes through applySuppression for two pools, reads SYSTEM/ROUTING only, and its record is the producer's", async () => {
    const dir = tempDir("gs-l6rd-");
    try {
      const published: Array<{ namespace: string; datums: readonly SuppressionDatum[] }> = [];
      let routingReads = 0;
      let clock = Date.parse("2026-10-02T02:00:00Z");
      const deps: OverlapDeps = {
        environment: ENV,
        readRouting: async () => {
          routingReads += 1;
          return { primary_pool: "p1", routing_version: 5 };
        },
        poolDocument: async (pool) => ({ environment: ENV, pool }),
        suppression: { publish: async (namespace, datums) => void published.push({ namespace, datums }) },
        now: () => clock,
        audit: () => undefined,
      };
      const file = path.join(dir, RESTORE_ALARM_FILES.suppression);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const opened = await openSuppressionOverlap(deps, { pools: ["p1", "p2"], minutes: 30, note: "l6-6 restore drill overlap", recordFile: file, apply: true });
      assert.equal(opened.kind, "opened", opened.detail);
      const plus = published.flatMap((p) => p.datums);
      assert.ok(published.every((p) => p.namespace === FLIP_SUPPRESSION.namespace));
      assert.equal(plus.length, 60, "one +1 per minute per pool, for exactly the two pools, for the window only");
      assert.deepEqual([...new Set(plus.map((d) => d.Dimensions.find((x) => x.Name === "Pool")?.Value))].sort(), ["p1", "p2"]);
      assert.ok(plus.every((d) => d.Value === 1 && d.MetricName === "FlipWindowOpen"));
      clock += 10 * 60_000;
      const closed = await closeSuppressionOverlap(deps, { recordFile: file, apply: true });
      assert.equal(closed.kind, "closed", closed.detail);
      assert.equal(published.flatMap((p) => p.datums).filter((d) => d.Value === -1).length, 40, "the minutes left of THIS window, cancelled");
      assert.equal(routingReads, 2, "SYSTEM/ROUTING read at the open and the close; there is no writer in the command at all");
      const w = suppressionRecordOf(dir);
      assert.ok(!("problem" in w), JSON.stringify(w));
      assert.deepEqual([(w as any).pools, (w as any).closed.routing_after], [["p1", "p2"], { primary_pool: "p1", routing_version: 5 }]);
    } finally {
      cleanup(dir);
    }
  });
});
