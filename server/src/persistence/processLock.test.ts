// server/src/persistence/processLock.test.ts
//
// LIVE-3B: one game server per data directory (LIVE-3 §8.8, F-12) -- and FI-28, two servers started at once. Every
// case runs in a temporary directory; nothing here touches `server/data`.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { acquireDataLock, lockStatus, LOCK_DIRECTORY } from "./processLock";
import { createFileLogStore } from "../fileLogStore";

function withDir<T>(tag: string, body: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `live3b-lock-${tag}-`));
  return body(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

/** Make a lock look abandoned: every sign of life `ageMs` old. */
function age(lockDir: string, ageMs: number): void {
  const when = new Date(Date.now() - ageMs);
  for (const name of fs.readdirSync(lockDir)) fs.utimesSync(path.join(lockDir, name), when, when);
  fs.utimesSync(lockDir, when, when);
}

/** A lock left by a process that is gone, with whatever owner record it managed to write. */
function strandedLock(dir: string, owner: object | null, ageMs: number): string {
  const lockDir = path.join(dir, LOCK_DIRECTORY);
  fs.mkdirSync(lockDir);
  if (owner !== null) {
    fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify(owner));
    fs.writeFileSync(path.join(lockDir, "heartbeat"), "0\n");
  }
  age(lockDir, ageMs);
  return lockDir;
}

describe("the data-directory lock (§8.8)", () => {
  test("one holder: a second server is refused while the heartbeat is fresh; release frees it", () =>
    withDir("basic", async (dir) => {
      const first = await acquireDataLock(dir, { instanceId: "first" });
      assert.ok(first.ok);
      const second = await acquireDataLock(dir, { instanceId: "second" });
      assert.equal(second.ok, false);
      if (!second.ok) {
        assert.match(second.reason, /another game server owns this data directory: instance first/);
        assert.equal(second.owner?.instance_id, "first");
      }
      assert.equal((await lockStatus(dir)).held, true);
      if (first.ok) {
        assert.equal(await first.lock.verify(), true);
        await first.lock.release();
      }
      assert.equal(fs.existsSync(path.join(dir, LOCK_DIRECTORY)), false);
      const third = await acquireDataLock(dir, { instanceId: "third" });
      assert.ok(third.ok && third.tookOver === null);
      if (third.ok) await third.lock.release();
    }));

  test("a stale heartbeat is taken over; the old holder's self-check finds itself fenced and writes nothing more", () =>
    withDir("stale", async (dir) => {
      const lost: string[] = [];
      const old = await acquireDataLock(dir, { instanceId: "old", heartbeatMs: 3_600_000, onLost: (why) => lost.push(why) });
      assert.ok(old.ok);
      if (!old.ok) return;
      const store = createFileLogStore(dir, { warn: () => undefined, writerCheck: () => old.lock.verify() });
      const entry = (index: number) => ({ index, id: `e${index}`, actor: "p-a", payload: "{}", at: index });
      assert.equal((await store.appendBatch("ROOM", [entry(0)])).kind, "committed");

      age(path.join(dir, LOCK_DIRECTORY), 45_000); // the old server hung or died: no heartbeat for 45 s
      const fresh = await acquireDataLock(dir, { instanceId: "new" });
      assert.ok(fresh.ok && fresh.tookOver !== null);
      if (!fresh.ok) return;
      assert.equal(fresh.tookOver?.previous?.instance_id, "old");

      assert.equal(await old.lock.verify(), false);
      assert.equal(lost.length, 1, "fenced exactly once");
      assert.match(lost[0], /now belongs to instance new/);
      assert.equal((await store.appendBatch("ROOM", [entry(1)])).kind, "definite", "a fenced process writes nothing");
      await old.lock.release(); // not ours any more: must not remove the new holder's lock
      assert.equal(await fresh.lock.verify(), true);
      await fresh.lock.release();
    }));

  test("a stale lock with no owner record (a crash between mkdir and write) is taken over", () =>
    withDir("anon", async (dir) => {
      strandedLock(dir, null, 60_000);
      const got = await acquireDataLock(dir, { instanceId: "after-crash" });
      assert.ok(got.ok && got.tookOver !== null && got.tookOver.previous === null);
      if (got.ok) await got.lock.release();
    }));

  test("a PID that exists proves nothing: a stale lock naming a live PID is taken over, a fresh one naming a dead PID is not", () =>
    withDir("pid", async (dir) => {
      // The PID is live (it is this very process) and the host matches -- a reused PID. The heartbeat decides.
      strandedLock(dir, { instance_id: "ghost", pid: process.pid, host: os.hostname(), started_at: 0 }, 60_000);
      const got = await acquireDataLock(dir, { instanceId: "real" });
      assert.ok(got.ok, "a live-looking PID with a stale heartbeat does not keep the lock");
      if (got.ok) await got.lock.release();

      // A fresh heartbeat naming a PID that does not exist: still refused -- the PID is only evidence.
      strandedLock(dir, { instance_id: "busy", pid: 2 ** 22 + 12345, host: "elsewhere", started_at: Date.now() }, 0);
      const refused = await acquireDataLock(dir, { instanceId: "impatient" });
      assert.equal(refused.ok, false);
    }));

  test("FI-28 (LIVE-2C): a takeover landing while a racer is still inspecting cannot hand that racer the winner's fresh lock", () =>
    withDir("toctou", async (dir) => {
      const lockDir = strandedLock(dir, { instance_id: "crashed", pid: 1, host: "h", started_at: 0 }, 60_000);
      /* The loaded-machine interleaving, made deterministic: exactly when the late racer reads the stale owner record,
         the winner moves the stale lock aside (under the name every racer derives) and creates its own fresh LOCK,
         which holds no owner record yet. */
      const promises = fs.promises as unknown as { readFile: (...args: unknown[]) => Promise<unknown> };
      const realReadFile = promises.readFile;
      let interleaved = false;
      promises.readFile = async (...args: unknown[]) => {
        if (!interleaved && String(args[0]) === path.join(lockDir, "owner.json")) {
          interleaved = true;
          fs.renameSync(lockDir, path.join(dir, `${LOCK_DIRECTORY}.stale.crashed`));
          fs.writeFileSync(path.join(dir, `${LOCK_DIRECTORY}.stale.crashed`, "taken-over-by-winner"), "0\n");
          fs.mkdirSync(lockDir);
        }
        return realReadFile.apply(fs.promises, args);
      };
      let late: Awaited<ReturnType<typeof acquireDataLock>>;
      try {
        late = await acquireDataLock(dir, { instanceId: "late-racer", heartbeatMs: 3_600_000 });
      } finally {
        promises.readFile = realReadFile;
      }
      assert.ok(interleaved, "the interleaving happened");
      assert.equal(late.ok, false, "the late racer met the winner's fresh lock and refused -- it did not move it aside");
      assert.ok(fs.existsSync(lockDir), "the winner's lock is where the winner made it");
      assert.deepEqual(
        fs.readdirSync(dir).filter((name) => name.startsWith(`${LOCK_DIRECTORY}.stale.`)),
        [`${LOCK_DIRECTORY}.stale.crashed`],
        "nothing but the stale lock was ever moved aside",
      );
      if (late.ok) await late.lock.release();
    }));

  test("simultaneous takeover racers over one stale lock: exactly one wins, every round", () =>
    withDir("race", async (dir) => {
      for (let round = 0; round < 25; round += 1) {
        fs.rmSync(path.join(dir, LOCK_DIRECTORY), { recursive: true, force: true });
        strandedLock(dir, round % 2 === 0 ? { instance_id: `dead-${round}`, pid: 1, host: "h", started_at: 0 } : null, 60_000);
        const racers = await Promise.all(
          Array.from({ length: 8 }, (_, n) => acquireDataLock(dir, { instanceId: `r${round}-${n}`, heartbeatMs: 3_600_000 })),
        );
        const winners = racers.filter((result) => result.ok);
        assert.equal(winners.length, 1, `round ${round}: ${winners.length} winners`);
        const owner = JSON.parse(fs.readFileSync(path.join(dir, LOCK_DIRECTORY, "owner.json"), "utf8"));
        const winner = winners[0];
        assert.ok(winner.ok && owner.instance_id === winner.lock.instanceId);
        for (const racer of racers) if (racer.ok) await racer.lock.release();
      }
    }));
});

/* ==================================================================
    FI-28: SEPARATE PROCESSES
   ================================================================== */
const COMPILED = __dirname; // dist/server/src/persistence
const run = (args: string[], env: NodeJS.ProcessEnv = {}) => {
  const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (chunk) => (out += String(chunk)));
  child.stderr.on("data", (chunk) => (out += String(chunk)));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, output: () => out, exited };
};
const waitFor = async (predicate: () => boolean, label: string, ms = 20_000) => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe("FI-28: processes", () => {
  test("six processes race to take one stale lock: exactly one wins", () =>
    withDir("procs", async (dir) => {
      strandedLock(dir, { instance_id: "crashed", pid: 1, host: "h", started_at: 0 }, 60_000);
      const script = path.join(dir, "racer.js");
      fs.writeFileSync(
        script,
        [
          `const { acquireDataLock } = require(${JSON.stringify(path.join(COMPILED, "processLock.js"))});`,
          "const [dir, id, at] = process.argv.slice(2);",
          "setTimeout(async () => {",
          "  const got = await acquireDataLock(dir, { instanceId: id, heartbeatMs: 3600000 });",
          "  process.stdout.write(JSON.stringify({ id, ok: got.ok }) + '\\n');",
          "  setTimeout(() => process.exit(0), 200);",
          "}, Math.max(0, Number(at) - Date.now()));",
        ].join("\n"),
      );
      const start = Date.now() + 700;
      const racers = Array.from({ length: 6 }, (_, n) => run([script, dir, `p${n}`, String(start)]));
      await Promise.all(racers.map((racer) => racer.exited));
      const results = racers.map((racer) => JSON.parse(racer.output().trim()) as { id: string; ok: boolean });
      const winners = results.filter((result) => result.ok);
      assert.equal(winners.length, 1, JSON.stringify(results));
      const owner = JSON.parse(fs.readFileSync(path.join(dir, LOCK_DIRECTORY, "owner.json"), "utf8"));
      assert.equal(owner.instance_id, winners[0].id);
    }));

  test("two game servers started at once on one data directory: one serves, one refuses with exit 2; nothing is shared", () =>
    withDir("servers", async (dir) => {
      const start = path.join(COMPILED, "..", "start.js");
      /* LIVE-2B: the mode is required (and `--insecure-local-identity` is gone); development is the local one. */
      const args = [start, "--mode", "development", "--port", "0", "--data", dir];
      const a = run(args);
      const b = run(args);
      const refused = await Promise.race([
        a.exited.then((code) => ({ which: a, other: b, code })),
        b.exited.then((code) => ({ which: b, other: a, code })),
      ]);
      assert.equal(refused.code, 2, refused.which.output());
      assert.match(refused.which.output(), /Refusing to start: another game server owns this data directory/);
      const survivor = refused.other;
      await waitFor(() => /data directory locked by instance (\w+)/.test(survivor.output()), "the survivor's banner");
      const instance = /data directory locked by instance (\w+)/.exec(survivor.output())?.[1];
      const owner = JSON.parse(fs.readFileSync(path.join(dir, LOCK_DIRECTORY, "owner.json"), "utf8"));
      assert.equal(owner.instance_id, instance, "the lock names the one server that runs");
      assert.equal(owner.pid, survivor.child.pid);
      // A third, later, is refused the same way.
      const c = run(args);
      assert.equal(await c.exited, 2);
      // A clean stop releases the directory.
      survivor.child.kill("SIGTERM");
      await survivor.exited;
      assert.equal(fs.existsSync(path.join(dir, LOCK_DIRECTORY)), false, survivor.output());
    }));
});
