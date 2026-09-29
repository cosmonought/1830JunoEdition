// server/src/persistence/conformance/faults.test.ts
//
// LIVE-5 L5-1: the fault-injection substrate is itself deterministic -- the same script fires on the same call every
// time, a stall holds until the test opens it (no timer anywhere), unfired faults are reported. The runner's own rules
// are pinned in `harness.test.ts`; F-L5-4, per port, in `fenceGap.test.ts`.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { nodeStoreFs } from "../../fileLogStore";
import { ControlledFence, FaultScript, faultyPort, faultyStoreFs, gate, InjectedFault } from "./faults";

const withDir = async (body: (dir: string) => Promise<void>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-l5faults-"));
  try {
    await body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

describe("L5-1 fault substrate", () => {
  test("a rule fires on exactly its n-th matching call, once, and every call is recorded", async () => {
    const script = new FaultScript([{ op: "load", nth: 3, action: { kind: "fail" }, label: "third load" }]);
    const port = faultyPort({ load: async (key: string) => `v:${key}` }, script);
    const answers: string[] = [];
    for (const key of ["a", "b", "c", "d"]) answers.push(await port.load(key).catch((error: Error) => `x:${error.name}`));
    assert.deepEqual(answers, ["v:a", "v:b", "x:InjectedFault", "v:d"]);
    assert.deepEqual(script.calls.map((call) => call.fault), [null, null, "fail", null]);
    assert.deepEqual(script.unfired(), []);
  });

  test("the same script is the same run: two identical scripts produce identical call traces", async () => {
    const run = async () => {
      const script = new FaultScript([
        { op: "put", where: (key) => key === "k2", action: { kind: "lose-answer" } },
        { op: "put", nth: 2, action: { kind: "duplicate" } },
      ]);
      const writes: string[] = [];
      const port = faultyPort({ put: async (key: string) => void writes.push(key) }, script);
      for (const key of ["k1", "k2", "k3", "k2"]) await port.put(key).catch(() => undefined);
      return { calls: script.calls, writes };
    };
    assert.deepEqual(await run(), await run());
  });

  test("lose-answer runs the operation, then fails the caller; duplicate delivers it twice", async () => {
    const writes: string[] = [];
    const script = new FaultScript([
      { op: "put", nth: 1, action: { kind: "lose-answer" } },
      { op: "put", nth: 2, action: { kind: "duplicate" } },
    ]);
    const port = faultyPort({ put: async (key: string) => void writes.push(key) }, script);
    await assert.rejects(port.put("a"), InjectedFault);
    await port.put("b");
    assert.deepEqual(writes, ["a", "b", "b"]);
  });

  test("a stall holds until the test opens the gate -- no timer is involved", async () => {
    const stall = gate();
    const script = new FaultScript([{ op: "get", action: { kind: "stall", gate: stall } }]);
    let done = false;
    const port = faultyPort({ get: async () => 42 }, script);
    const pending = port.get().then((value) => ((done = true), value));
    await stall.reached;
    for (let spin = 0; spin < 50; spin += 1) await Promise.resolve();
    assert.equal(done, false);
    stall.release();
    assert.equal(await pending, 42);
  });

  test("unfired faults are reported (a fault that never fires proves nothing)", () => {
    const script = new FaultScript([{ op: "never", action: { kind: "fail" }, label: "the never rule" }]);
    assert.deepEqual(script.unfired(), ["the never rule"]);
  });

  test("the file seam: partial and short writes reach the file exactly as scripted", async () => {
    await withDir(async (dir) => {
      const file = path.join(dir, "f.bin");
      const script = new FaultScript([
        { op: "write", nth: 1, action: { kind: "partial", bytes: 3 } },
        { op: "write", nth: 2, action: { kind: "short", bytes: 2 } },
      ]);
      const io = faultyStoreFs(nodeStoreFs, script);
      const handle = await io.open(file, "wx");
      await assert.rejects(handle.write(Buffer.from("abcdef"), 0, 6, 0), InjectedFault);
      assert.equal(fs.readFileSync(file, "utf8"), "abc");
      assert.equal((await handle.write(Buffer.from("XYZ"), 0, 3, 3)).bytesWritten, 2);
      await handle.close();
      assert.equal(fs.readFileSync(file, "utf8"), "abcXY");
    });
  });

  test("the fence: writers issued before a takeover are stale; writers issued after are current", async () => {
    const fence = new ControlledFence();
    const early = fence.writer();
    assert.equal(await early(), true);
    const hooked: number[] = [];
    fence.onTakeOver(async (epoch) => void hooked.push(epoch));
    assert.equal(await fence.takeOver(), 2);
    assert.equal(await early(), false);
    assert.equal(await fence.writer()(), true);
    assert.deepEqual(hooked, [2]);
  });
});
