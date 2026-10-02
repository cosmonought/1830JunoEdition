/* LIVE-6 L6-6 (restore drill tooling): `gamesDoctor aws suppression-overlap` -- the staging flip-suppression overlap test.
 * The planned flip's own suppression (applySuppression) for exactly two pools of this deployment, bounded, evidence first,
 * SYSTEM/ROUTING read and never written; every refusal; a failed publication; the close; the CLI's usage. No AWS. */
import { strict as assert } from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, test } from "node:test";

import type { SuppressionDatum } from "../controlPlane/flipSuppression";
import { parseSuppressionOverlap, SUPPRESSION_OVERLAP_STATEMENT } from "../controlPlane/suppressionOverlap";
import { runAwsOperator } from "./operatorMain";
import { closeSuppressionOverlap, openSuppressionOverlap, type OverlapDeps } from "./suppressionOverlap";

const T0 = Date.parse("2026-10-02T02:00:00Z");

function deps(over: Partial<OverlapDeps> & { readonly routing?: Array<{ primary_pool: string; routing_version: number } | null | Error> } = {}) {
  const published: SuppressionDatum[][] = [];
  const audits: Array<Record<string, unknown>> = [];
  const routing = [...(over.routing ?? [{ primary_pool: "p1", routing_version: 5 }])];
  let clock = T0;
  const d: OverlapDeps = {
    environment: "staging",
    readRouting: async () => {
      const next = routing.length > 1 ? routing.shift() : routing[0];
      if (next instanceof Error) throw next;
      return next ?? null;
    },
    poolDocument: async (pool) => ({ environment: "staging", pool }),
    suppression: { publish: async (_namespace, datums) => void published.push([...datums]) },
    now: () => clock,
    audit: (event, fields) => void audits.push({ event, ...fields }),
    ...over,
  };
  return { d, published, audits, tick: (ms: number) => (clock += ms) };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gs-overlap-"));

describe("suppression-overlap: a staging flip-suppression overlap test, never a routing flip", () => {
  test("dry run: plans the datapoints, writes and publishes nothing", async () => {
    const dir = tmp();
    try {
      const { d, published } = deps();
      const file = path.join(dir, "w.json");
      const a = await openSuppressionOverlap(d, { pools: ["p1", "p2"], minutes: 20, note: "drill", recordFile: file, apply: false });
      assert.equal(a.kind, "planned");
      assert.match(a.detail, /would publish 40 FlipWindowOpen datapoints .* SYSTEM\/ROUTING v5 \(primary p1\) is only read/);
      assert.equal(fs.existsSync(file), false);
      assert.equal(published.length, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("apply: the record FIRST (create-once), then the planned flip's datapoints for exactly the two pools; the record says what it is", async () => {
    const dir = tmp();
    try {
      const { d, published, audits } = deps();
      const file = path.join(dir, "w.json");
      const a = await openSuppressionOverlap(d, { pools: ["p1", "p2"], minutes: 45, note: "drill", recordFile: file, apply: true });
      assert.equal(a.kind, "opened", a.detail);
      const rec = parseSuppressionOverlap(fs.readFileSync(file, "utf8"));
      assert.ok(!("problem" in rec));
      assert.equal((rec as any).statement, SUPPRESSION_OVERLAP_STATEMENT);
      assert.match(SUPPRESSION_OVERLAP_STATEMENT, /NOT a routing flip/);
      assert.deepEqual((rec as any).routing_before, { primary_pool: "p1", routing_version: 5 });
      assert.equal((rec as any).open.outcome, "published");
      assert.equal(published.flat().length, 90);
      assert.ok(published.flat().every((x) => x.Value === 1 && x.MetricName === "FlipWindowOpen" && x.Timestamp < T0 + 45 * 60_000));
      assert.equal(audits[0].event, "operator.suppression-overlap");
      /* A second open never overwrites the record. */
      const again = await openSuppressionOverlap(d, { pools: ["p1", "p2"], minutes: 10, note: "drill", recordFile: file, apply: true });
      assert.equal(again.kind, "refused");
      assert.match(again.detail, /never overwritten/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refusals: prod, not two distinct pools, over 45 minutes, a pool outside the deployment, routing absent or unreadable, no note", async () => {
    const dir = tmp();
    try {
      const file = path.join(dir, "w.json");
      const cases: Array<[Partial<Parameters<typeof deps>[0]>, Partial<Parameters<typeof openSuppressionOverlap>[1]>, RegExp]> = [
        [{ environment: "prod" }, {}, /never runs in a prod/],
        [{}, { pools: ["p1"] }, /exactly two distinct pools/],
        [{}, { pools: ["p1", "p1"] }, /exactly two distinct pools/],
        [{}, { pools: ["p1", "p2", "p3"] }, /exactly two distinct pools/],
        [{}, { minutes: 46 }, /1\.\.45/],
        [{}, { minutes: 0 }, /1\.\.45/],
        [{}, { note: " " }, /--note/],
        [{ poolDocument: async () => ({ environment: "staging", pool: "p9" }) }, {}, /names staging\/p9, not staging\/p1/],
        [{ poolDocument: async () => Promise.reject(new Error("ParameterNotFound")) }, {}, /not a pool of this deployment/],
        [{ routing: [null] }, {}, /does not exist: the test must show that the routing did not move/],
        [{ routing: [new Error("RoutingUnreadableError")] }, {}, /could not be read/],
      ];
      for (const [over, input, why] of cases) {
        const { d, published } = deps(over);
        const a = await openSuppressionOverlap(d, { pools: ["p1", "p2"], minutes: 30, note: "drill", recordFile: file, apply: true, ...input });
        assert.equal(a.kind, "refused", String(why));
        assert.match(a.detail, why);
        assert.equal(published.length, 0);
        assert.equal(fs.existsSync(file), false, "nothing written");
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a publication that fails is recorded (refused), and nothing else happens", async () => {
    const dir = tmp();
    try {
      const { d } = deps({ suppression: { publish: async () => Promise.reject(Object.assign(new Error("denied"), { name: "AccessDeniedException" })) } });
      const file = path.join(dir, "w.json");
      const a = await openSuppressionOverlap(d, { pools: ["p1", "p2"], minutes: 10, note: "drill", recordFile: file, apply: true });
      assert.equal(a.kind, "refused");
      assert.equal((parseSuppressionOverlap(fs.readFileSync(file, "utf8")) as any).open.outcome, "failed");
      assert.equal((parseSuppressionOverlap(fs.readFileSync(file, "utf8")) as any).open.detail, "AccessDeniedException");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("close: the remaining minutes cancelled (-1), SYSTEM/ROUTING read again; a moved routing makes the test worthless; idempotent; after expiry nothing to publish", async () => {
    const dir = tmp();
    try {
      const file = path.join(dir, "w.json");
      const s = deps();
      await openSuppressionOverlap(s.d, { pools: ["p1", "p2"], minutes: 30, note: "drill", recordFile: file, apply: true });
      s.tick(10 * 60_000);
      const dry = await closeSuppressionOverlap(s.d, { recordFile: file, apply: false });
      assert.equal(dry.kind, "planned");
      const c = await closeSuppressionOverlap(s.d, { recordFile: file, apply: true });
      assert.equal(c.kind, "closed", c.detail);
      assert.equal(s.published.flat().filter((x) => x.Value === -1).length, 40);
      const twice = await closeSuppressionOverlap(s.d, { recordFile: file, apply: true });
      assert.equal(twice.kind, "closed");
      assert.match(twice.detail, /already closed/);
      assert.equal(s.published.flat().filter((x) => x.Value === -1).length, 40, "a close is published once");

      const file2 = path.join(dir, "w2.json");
      const moved = deps({ routing: [{ primary_pool: "p1", routing_version: 5 }, { primary_pool: "p2", routing_version: 6 }] });
      await openSuppressionOverlap(moved.d, { pools: ["p1", "p2"], minutes: 30, note: "drill", recordFile: file2, apply: true });
      const m = await closeSuppressionOverlap(moved.d, { recordFile: file2, apply: true });
      assert.equal(m.kind, "refused");
      assert.match(m.detail, /cannot certify anything/);

      const file3 = path.join(dir, "w3.json");
      const late = deps();
      await openSuppressionOverlap(late.d, { pools: ["p1", "p2"], minutes: 5, note: "drill", recordFile: file3, apply: true });
      late.tick(6 * 60_000);
      const e = await closeSuppressionOverlap(late.d, { recordFile: file3, apply: true });
      assert.equal(e.kind, "closed");
      assert.equal((parseSuppressionOverlap(fs.readFileSync(file3, "utf8")) as any).closed.outcome, "expired");
      assert.equal(late.published.flat().filter((x) => x.Value === -1).length, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the CLI: suppression-overlap open needs two pools, close none; unknown flags refused before anything is resolved", async () => {
    for (const argv of [["suppression-overlap", "open", "p1"], ["suppression-overlap", "close", "p1"], ["suppression-overlap", "flip", "p1", "p2"], ["suppression-overlap"]]) {
      const err: string[] = [];
      const code = await runAwsOperator(argv, {}, { out: () => undefined, err: (l) => err.push(l) });
      assert.equal(code, 2, argv.join(" "));
      assert.match(err.join("\n"), /suppression-overlap open <A> <B>/);
    }
    const err: string[] = [];
    assert.equal(await runAwsOperator(["suppression-overlap", "open", "p1", "p2", "--force"], {}, { out: () => undefined, err: (l) => err.push(l) }), 2);
    assert.match(err.join("\n"), /unknown option --force/);
  });

  test("source: the command reaches no DynamoDB writer, no routing CAS, no alarm action switch", () => {
    const text = fs.readFileSync(path.join(__dirname, "../../../../../src/aws/operator/suppressionOverlap.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const forbidden of ["setPrimaryPool", "PutItem", "UpdateItem", "TransactWrite", "DisableAlarmActions", "EnableAlarmActions", "SetAlarmState", "PutMetricAlarm", "takeOverPool", "claimGame"]) assert.ok(!text.includes(forbidden), forbidden);
    assert.match(text, /applySuppression\(deps\.suppression, span, "open"/);
  });
});
