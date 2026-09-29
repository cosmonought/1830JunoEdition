// server/src/persistence/conformance/harness.test.ts
//
// LIVE-5 L5-1: the conformance runner's own rules. A capability gap or a declared difference is a visible skip, never
// a pass; a DynamoDB subject cannot drop a required capability without a named exemption; a declared capability needs
// its hook; a difference must name a real case; a scripted fault that never fires fails the case; cleanup removes only
// a case's own directory.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { REQUIRED_CAPABILITIES, removeCaseDirectory, runCase, skipReason, subjectProblem, type ConformanceCase, type SubjectBase } from "./harness";

type Probe = SubjectBase & { stored(): Promise<null>; [hook: string]: unknown };
const base = (over: Partial<Probe> = {}): Probe => ({ name: "probe", backend: "memory", capabilities: [], stored: async () => null, ...over });
const CASES: ConformanceCase<Probe>[] = [
  { id: "P-1", title: "plain", run: async () => undefined },
  { id: "P-2", title: "needs a fence inside the write", needs: ["fence", "fence-in-write"], run: async () => undefined },
];

describe("L5-1 conformance runner", () => {
  test("a missing capability and a declared difference are skips with their reason, never passes", () => {
    assert.equal(skipReason(base(), CASES[0]), null);
    assert.match(skipReason(base({ capabilities: ["fence"] }), CASES[1]) ?? "", /does not declare fence-in-write/);
    assert.match(skipReason(base({ differences: { "P-1": "because" } }), CASES[0]) ?? "", /intentional difference: because/);
  });

  test("a DynamoDB subject must declare every required capability, or name each omission as an exemption", () => {
    const all = REQUIRED_CAPABILITIES.dynamodb;
    assert.ok(all.includes("fence-in-write") && all.includes("idempotency-token") && all.includes("inject-lost-answer"));
    const hooks = { plant: async () => undefined, stallNextWrite: () => undefined, writeTokens: () => [], armLostAnswer: () => undefined, armTransientFailure: () => undefined };
    assert.equal(subjectProblem(base({ backend: "dynamodb", capabilities: [...all], ...hooks }), CASES), null);
    const without = all.filter((cap) => cap !== "fence-in-write");
    assert.match(subjectProblem(base({ backend: "dynamodb", capabilities: without, ...hooks }), CASES) ?? "", /must declare fence-in-write/);
    assert.equal(subjectProblem(base({ backend: "dynamodb", capabilities: without, exemptions: { "fence-in-write": "reviewed reason" }, ...hooks }), CASES), null);
    assert.match(subjectProblem(base({ backend: "dynamodb", capabilities: [...all], exemptions: { "fence-in-write": "x" }, ...hooks }), CASES) ?? "", /both declares and exempts/);
  });

  test("a declared capability needs its hook; every subject needs `stored`; a difference must name a real case", () => {
    assert.match(subjectProblem(base({ capabilities: ["inject-lost-answer"] }), CASES) ?? "", /without its hook `armLostAnswer`/);
    assert.match(subjectProblem({ name: "no-stored", backend: "memory", capabilities: [] } as unknown as Probe, CASES) ?? "", /no `stored` hook/);
    assert.match(subjectProblem(base({ differences: { "P-9": "x" } }), CASES) ?? "", /unknown case P-9/);
  });

  test("a case whose scripted fault never fires FAILS", async () => {
    const lazy: ConformanceCase<Probe> = { id: "P-3", title: "scripts a fault it never triggers", run: async (_subject, ctx) => void ctx.faults.add({ op: "never", action: { kind: "fail" } }) };
    await assert.rejects(runCase(base(), lazy), /every scripted fault must fire/);
  });

  test("cleanup removes the case's own directory -- and refuses anything that is not one", async () => {
    let seen = "";
    await runCase(base(), { id: "P-4", title: "records its dir", run: async (_subject, ctx) => void (seen = ctx.dir) });
    assert.ok(seen.startsWith(path.join(os.tmpdir(), "gs-l5conf-")));
    assert.equal(fs.existsSync(seen), false, "the case directory is gone");
    const foreign = fs.mkdtempSync(path.join(os.tmpdir(), "not-ours-"));
    try {
      assert.equal(removeCaseDirectory(foreign), false);
      assert.equal(removeCaseDirectory(path.join(foreign, "gs-l5conf-nested")), false, "a prefixed directory NOT directly under the temp directory");
      assert.equal(fs.existsSync(foreign), true);
    } finally {
      fs.rmSync(foreign, { recursive: true, force: true });
    }
  });

  test("a case's cleanups run even when the case fails", async () => {
    let cleaned = false;
    await assert.rejects(
      runCase(base(), {
        id: "P-5",
        title: "fails",
        run: async (_subject, ctx) => {
          ctx.defer(() => void (cleaned = true));
          throw new Error("the case failed");
        },
      }),
      /the case failed/,
    );
    assert.equal(cleaned, true);
  });
});
