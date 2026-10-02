// server/src/aws/operator/cost2aHostSnapshot.test.ts
//
// COST-2A: `gamesDoctor aws host-snapshot --out <file>` -- the runtime half of the single host's evidence, offline (stub
// DynamoDB clients; the operator's readers over real items are the DynamoDB Local suite's). Pinned: read-only (--apply is
// refused, nothing but reads are sent), the file is written whole (never a .partial left, never a partial file), every
// answer keeps its state (a failed read is `unavailable`, a failed money listing is an `error` -- never an empty listing),
// the route table's every pool is read, and no credential's value reaches the output.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { GetItemCommand, QueryCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

import type { ParameterSource } from "../runtime/configSource";
import { EXIT, runAwsOperator } from "./operatorMain";
import { HOST_RUNTIME_SNAPSHOT_FORMAT } from "./hostSnapshot";

const RUNTIME_ARN = "arn:aws:ssm:us-east-1:111111111111:parameter/gs/staging/runtime/p1";
const LEDGER_ARN = "arn:aws:dynamodb:us-east-1:222222222222:table/gs-staging-ledger";
const DOC = {
  format: "18COSMOS/AWS-RUNTIME/v2",
  environment: "staging",
  region: "us-east-1",
  pool: "p1",
  generation: 1,
  game_table: "gs-staging-game-g1",
  identity_table: "gs-staging-identity",
  ledger_table_arn: LEDGER_ARN,
  escrow: null,
  routes: { p1: { ws_path: "/gs/p/p1" }, p2: { ws_path: "/gs/p/p2" } },
};
const SECRET = { AWS_SECRET_ACCESS_KEY: "hostile-secret-value-do-not-print" };

const parameters: ParameterSource = {
  async read(arn) {
    if (arn !== RUNTIME_ARN) throw new Error(`no parameter ${arn}`);
    return { value: JSON.stringify(DOC), version: 4, arn };
  },
};

/** "fails": every call times out. "empty": every item absent, every query empty. Both count what they are sent. */
function client(mode: "fails" | "empty", sent: string[]): DynamoDBClient {
  return {
    async send(command: unknown) {
      const name = (command as { constructor: { name: string } }).constructor.name;
      sent.push(name);
      if (mode === "fails") throw Object.assign(new Error("simulated: the endpoint did not answer"), { name: "TimeoutError" });
      if (command instanceof GetItemCommand) return {};
      if (command instanceof QueryCommand) return { Items: [], Count: 0 };
      throw new Error(`unexpected ${name}`);
    },
    destroy() {
      /* nothing */
    },
  } as unknown as DynamoDBClient;
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, sink: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

describe("COST-2A: gamesDoctor aws host-snapshot", () => {
  test("every read failing: the snapshot is still written, whole, each answer `unavailable`, the money listing an error (exit 1)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cost2a-snap-"));
    const file = path.join(dir, "runtime-snapshot.json");
    const sent: string[] = [];
    const o = io();
    try {
      const code = await runAwsOperator(["host-snapshot", "--aws-config", RUNTIME_ARN, "--out", file], {}, o.sink, { parameters, clientFor: () => client("fails", sent), now: () => Date.parse("2026-10-02T18:00:00Z") });
      assert.equal(code, EXIT.findings, o.err.join("\n"));
      const snap = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, any>;
      assert.equal(snap.format, HOST_RUNTIME_SNAPSHOT_FORMAT);
      assert.equal(snap.captured_at, "2026-10-02T18:00:00.000Z");
      assert.equal(snap.environment, "staging");
      assert.equal(snap.generation, 1);
      assert.equal(snap.configured_pool, "p1");
      assert.equal(snap.status.routing.state, "unavailable");
      assert.equal(snap.status.appgen.state, "unavailable");
      assert.deepEqual(snap.route_pools.map((p: { pool: string }) => p.pool), ["p1", "p2"], "every pool of the route table");
      assert.ok(snap.route_pools.every((p: { item: { state: string } }) => p.item.state === "unavailable"));
      assert.equal(snap.money.source, "open-money");
      assert.equal(snap.money.games, undefined, "a failed listing is never an empty one");
      assert.match(snap.money.error, /TimeoutError/);
      assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith(".partial")));
      assert.ok(sent.every((n) => n === "GetItemCommand" || n === "QueryCommand"), `reads only: ${[...new Set(sent)].join(", ")}`);
      assert.match(o.out[0], /host snapshot \(READ-ONLY\) written/);
      assert.ok(o.out.some((l) => /money listing FAILED/.test(l)));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("empty tables: absent stays absent (findings named), an empty money listing is a listing; reads only (exit 0)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cost2a-snap-"));
    const file = path.join(dir, "nested", "runtime-snapshot.json");
    const sent: string[] = [];
    const o = io();
    try {
      const code = await runAwsOperator(["host-snapshot", "--out", file], { GS_AWS_CONFIG_PARAMETER: RUNTIME_ARN }, o.sink, { parameters, clientFor: () => client("empty", sent) });
      assert.equal(code, EXIT.ok, o.err.join("\n"));
      const snap = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, any>;
      assert.equal(snap.status.routing.state, "absent");
      assert.equal(snap.status.identity_writer.role.state, "absent");
      assert.ok(snap.status.findings.length > 0, "an absent routing / role is a named finding (the verifier then fails or does not evaluate)");
      assert.deepEqual(snap.money, { source: "open-money", games: [], problems: [] });
      assert.ok(sent.every((n) => n === "GetItemCommand" || n === "QueryCommand"), `reads only: ${[...new Set(sent)].join(", ")}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refused: --apply (read-only), no --out; a credential in the environment is refused by name, never by value", async () => {
    const sent: string[] = [];
    const a = io();
    assert.equal(await runAwsOperator(["host-snapshot", "--aws-config", RUNTIME_ARN, "--out", "x.json", "--apply"], {}, a.sink, { parameters, clientFor: () => client("empty", sent) }), EXIT.usage);
    assert.match(a.err.join("\n"), /read-only/);
    const b = io();
    assert.equal(await runAwsOperator(["host-snapshot", "--aws-config", RUNTIME_ARN], {}, b.sink, { parameters, clientFor: () => client("empty", sent) }), EXIT.usage);
    assert.match(b.err.join("\n"), /--out <file> is required/);
    const c = io();
    assert.equal(await runAwsOperator(["host-snapshot", "--aws-config", RUNTIME_ARN, "--out", "x.json"], SECRET, c.sink, { parameters, clientFor: () => client("empty", sent) }), EXIT.usage);
    assert.ok(!`${c.out.join("\n")}${c.err.join("\n")}`.includes(SECRET.AWS_SECRET_ACCESS_KEY));
    assert.equal(sent.length, 0, "nothing was read for a refused command");
  });
});
