// server/src/aws/deploy/hostcert/hostCert.test.ts
//
// COST-2C: the single-host mutating certification drills, OFFLINE. A simulated host / control plane / fleet / table
// (`hostCertTestSupport.ts`) behaving as COST-1 says the real host behaves -- and with every fault the brief names --
// plus the real bash templates run against stub commands, and the real gs-exit-hold run for the HOLD law's parity.
//
// What NO test here can do: certify the AL2023 / systemd contract. Every offline drill ends NOT EVALUATED with
// "REQUIRES REAL AL2023" on its `real AL2023 host` check -- asserted below for every scenario.

import { strict as assert } from "assert";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, test } from "node:test";

import type { DeployDeps } from "../commands";
import { readGenerationEvidence } from "../staging/recovery";
import { secretFindings, stableStringify, writeRecord } from "../staging/evidence";
import { cliInvocation, createCliFleetView, createSsmHostTransport, CREDENTIAL_ENV, isLiveWorld, productionHostCertWorld, ssmCommandLine, type AwsCli } from "./awsCliTransport";
import { evidenceFileOf, expectedHostFiles, hostCertCommand } from "./commands";
import { judgeQuiet, judgeSingleWriter, openMoneyState, readAuthority } from "./controlPlane";
import { acquireLock, CLOCK_SKEW_MS, LOCK_PK, readLock, releaseLock, renewLock } from "./drillLock";
import { addMoneyGame, BUILD, DIGEST, EIP, fakeTable, FakeWorld, GAME_TABLE, INSTANCE, NEW_INSTANCE, RELAYER, type Faults } from "./hostCertTestSupport";
import { HOST_FRAME, HOST_OP_KINDS, hostScript, parseHostOutput, recorderScript, type HostOp } from "./hostOps";
import { expectedHold, judgeExit, judgeUnit, parseExit, parseObservation, type HostState } from "./hostState";
import { runDrill, SCENARIOS, type DrillInput, type ReplacementBaseline, type Scenario } from "./scenarios";

import { REQUIRES_REAL_AL2023, verdictOf, type CertCheck } from "./verdict";

const REPO = ((): string => {
  let dir = __dirname;
  while (!fs.existsSync(path.join(dir, "PROJECT_CANONICAL_CONTEXT.md"))) {
    const up = path.dirname(dir);
    if (up === dir) throw new Error("repository root not found");
    dir = up;
  }
  return dir;
})();
const SRC = path.join(REPO, "server", "src");
/* bash (with sha256sum / base64) for the template, recorder and gs-exit-hold tests. On Windows the owner gate points
   GS_TEST_BASH at Git Bash; without one those tests SKIP, by name (the owner gate treats a skip here as NOT RUN). */
const BASH: string | null = process.env.GS_TEST_BASH !== undefined && process.env.GS_TEST_BASH !== "" ? process.env.GS_TEST_BASH : process.platform === "win32" ? null : spawnSync("bash", ["-c", "command -v sha256sum >/dev/null && command -v base64 >/dev/null"]).status === 0 ? "bash" : null;
const NO_BASH: string | false = BASH === null ? "bash with sha256sum / base64 is not available (Windows: set GS_TEST_BASH to Git Bash; the owner gate does)" : false;
const bash = (args: readonly string[], options: { readonly env?: NodeJS.ProcessEnv; readonly input?: string } = {}): { readonly status: number | null; readonly stdout: string; readonly stderr: string } => {
  const r = spawnSync(BASH as string, [...args], { encoding: "utf8", ...(options.env !== undefined ? { env: options.env } : {}), ...(options.input !== undefined ? { input: options.input } : {}) });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};
const posix = (p: string): string => p.replace(/\\/g, "/");
const PATH_SEP = process.platform === "win32" ? ";" : ":";
/** A repository host file with LF line endings (a Windows checkout may hold CRLF; the host receives LF). */
const lfCopy = (rel: string, dir: string): string => {
  const out = path.join(dir, path.basename(rel));
  fs.writeFileSync(out, fs.readFileSync(path.join(REPO, rel), "utf8").replace(/\r\n/g, "\n"), { mode: 0o755 });
  return out;
};
const FILES = expectedHostFiles(REPO);
const RUN = "cost2c-test-run";
const COMMIT = "1".repeat(40);

interface Drilled {
  readonly result: Awaited<ReturnType<typeof runDrill>>;
  readonly world: FakeWorld;
  readonly table: ReturnType<typeof fakeTable>;
}

function inputFor(scenario: Scenario, more: Partial<DrillInput> = {}): DrillInput {
  return { scenario, run: RUN, environment: "staging", generation: 1, pool: "p1", gameTable: GAME_TABLE, instanceId: INSTANCE, digest: DIGEST, build: BUILD, sourceCommit: COMMIT, operator: "owner", ecsCluster: "gs-staging", reclaimStaleLock: null, ...more };
}

async function drill(scenario: Scenario, faults: Faults = {}, setup: (w: FakeWorld, t: ReturnType<typeof fakeTable>) => void = () => undefined, more: Partial<DrillInput> = {}, worldIn?: FakeWorld, tableIn?: ReturnType<typeof fakeTable>, document?: Partial<{ environment: string; escrowNetwork: "mainnet" | "testnet" | "local" | null }>): Promise<Drilled> {
  const world = worldIn ?? new FakeWorld(faults);
  world.expectedFiles = FILES;
  const table = tableIn ?? fakeTable();
  setup(world, table);
  const readers = world.cp.readers();
  const clients = { app: table.client, ledger: table.client };
  const result = await runDrill(inputFor(scenario, more), {
    world,
    readers,
    target: { clients, tables: { game: GAME_TABLE, identity: "gs-staging-identity", ledger: "ledger" }, pool: "p1", relayer: RELAYER },
    generationEvidence: () => readGenerationEvidence(readers.recovery, clients, { game: GAME_TABLE, ledger: "ledger" }),
    document: { environment: document?.environment ?? "staging", pool: "p1", generation: 1, gameTable: GAME_TABLE, escrowNetwork: document?.escrowNetwork === undefined ? "testnet" : document.escrowNetwork },
    expectedFiles: FILES,
    lock: { client: table.client, table: GAME_TABLE },
  });
  return { result, world, table };
}

const allChecks = (r: Drilled["result"]): CertCheck[] => {
  const p = r.record.phases as Record<string, unknown>;
  const list = (v: unknown): CertCheck[] => (Array.isArray(v) ? (v as CertCheck[]) : ((v as { checks: CertCheck[] }).checks ?? []));
  return ["precheck", "mutation", "observation", "cleanup", "postcheck"].flatMap((k) => list(p[k]));
};
const nonPass = (r: Drilled["result"]): CertCheck[] => allChecks(r).filter((c) => c.status !== "pass");
const failing = (r: Drilled["result"], pattern: RegExp): boolean => allChecks(r).some((c) => c.status === "fail" && pattern.test(c.name));
const show = (r: Drilled["result"]): string => nonPass(r).map((c) => `${c.status} ${c.name}: ${c.detail}`).join("\n");

const OFFLINE_ONLY = /^real AL2023 host/;

/* ================================================================== */
describe("COST-2C: every scenario, offline, as COST-1 says the host behaves -- every check passes EXCEPT the real-AL2023 one", () => {
  for (const scenario of ["graceful-stop", "crash-restart", "reboot-restart", "duplicate-preflight", "duplicate-fence"] as const) {
    test(`${scenario}: NOT EVALUATED / REQUIRES REAL AL2023 -- never PASS offline`, async () => {
      const { result, world } = await drill(scenario);
      assert.equal(result.refused, false, show(result));
      const open = nonPass(result);
      assert.deepEqual(open.map((c) => c.name).filter((n) => !OFFLINE_ONLY.test(n)), [], show(result));
      assert.equal(open.length, 1);
      assert.equal(open[0].status, "not-evaluated");
      assert.match(open[0].detail, new RegExp(REQUIRES_REAL_AL2023.replace(/\//g, "\\/")));
      assert.equal(result.verdict, "NOT EVALUATED");
      assert.equal(result.record.real_al2023, REQUIRES_REAL_AL2023);
      assert.equal((result.record.transport as { live: boolean }).live, false);
      assert.equal(isLiveWorld(world), false);
      /* The drill left nothing behind, released the lock, and the evidence carries no secret. */
      const host = world.hosts.get(INSTANCE);
      assert.ok(host !== undefined && host.dropIns.length === 0 && host.hold === null && host.proc !== null);
      assert.deepEqual(secretFindings(stableStringify(result.record), { ownRecord: true }), []);
      for (const k of ["run_id", "scenario", "source_commit", "instance_id", "release", "before", "authorities", "observations", "steps", "verdict"]) assert.ok(k in result.record, k);
    });
  }

  test("F7 graceful-stop: exit 0, readiness 503 first, no HOLD, no restart; the same digest serves again; generation/pool unchanged", async () => {
    const { result } = await drill("graceful-stop");
    const names = allChecks(result).filter((c) => c.status === "pass").map((c) => c.name);
    for (const n of ["F7: the process exited 0", "F7: no HOLD for a non-fence exit", "F7: readiness goes unavailable first", "F7: stopped, not restarted", "F7 redeploy: ownership: POOL epoch strictly newer", "F7: authorities remain this generation / pool"]) assert.ok(names.includes(n), n);
  });

  test("F8 crash-restart: a non-fence exit 137, no HOLD, exactly one automatic restart, newer epochs, roles moved consistently", async () => {
    const { result } = await drill("crash-restart");
    const names = allChecks(result).filter((c) => c.status === "pass").map((c) => c.name);
    for (const n of ["F8: an ordinary crash (not a fence exit)", "F8: no HOLD at any observation", "F8: systemd restarted it (once)", "F8 restart: ownership: POOL epoch strictly newer", "F8 restart: ownership: identity-writer epoch strictly newer", "F8 restart: ownership: relayer epoch strictly newer", "F8 restart: writer: the identity writer and the relayer agree"]) assert.ok(names.includes(n), n);
  });

  test("F9b duplicate-fence: exit 3, NOT restarted, ExecStopPost got exited/3, HOLD written, survives reboot, refusals, a refused deploy keeps it, gs-deploy clears it, one newer writer", async () => {
    const { result, world } = await drill("duplicate-fence");
    const names = allChecks(result).filter((c) => c.status === "pass").map((c) => c.name);
    for (const n of [
      "F9b: the fenced process exited 3 (or the certified role-change 5)",
      "F9b: systemd passes EXIT_CODE / EXIT_STATUS to ExecStopPost",
      "F9b: ExecMainCode / ExecMainStatus are the fenced exit",
      "F9b: gs-exit-hold wrote the HOLD",
      "F9b: systemd did NOT restart it",
      "F9b: the preflight refuses on HOLD",
      "F9b: an ordinary start is refused on HOLD",
      "F9b: the HOLD survives the reboot",
      "F9b: no server process after the reboot",
      "F9b: a refused deploy keeps the HOLD",
      "F9b recovery: ownership: POOL epoch strictly newer",
      "F9b: no duplicate writer survives",
    ]) assert.ok(names.includes(n), n);
    const log = world.hosts.get(INSTANCE)?.log ?? [];
    assert.ok(log.indexOf("deploy-refused-probe") < log.lastIndexOf("deploy"), "the refused deploy precedes the clearing deploy");
  });

  test("F9b with the certified role-change exit 5: the same HOLD law", async () => {
    const { result } = await drill("duplicate-fence", { fenceStatus: 5 });
    assert.deepEqual(nonPass(result).map((c) => c.name).filter((n) => !OFFLINE_ONLY.test(n)), [], show(result));
  });
});

/* ================================================================== */
describe("COST-2C: false PASS is impossible -- each fault FAILS, refuses or stays NOT EVALUATED", () => {
  const expectFail = async (scenario: Scenario, faults: Faults, pattern: RegExp) => {
    const { result } = await drill(scenario, faults);
    assert.equal(result.verdict, "FAIL", show(result));
    assert.ok(failing(result, pattern), `${pattern}\n${show(result)}`);
  };
  test("automatic restart after a fence => FAIL", () => expectFail("duplicate-fence", { restartAfterFence: true }, /systemd did NOT restart it/));
  test("a restart after a fence that lost again at once (NRestarts moved, the service down again) => FAIL", () => expectFail("duplicate-fence", { restartAfterFenceOnce: true }, /systemd did NOT restart it/));
  test("fence epoch not increasing after restart => FAIL", () => expectFail("crash-restart", { epochNotIncreasing: true }, /POOL epoch strictly newer/));
  test("identity / relayer disagreement => FAIL", () => expectFail("crash-restart", { relayerStays: true }, /identity writer and the relayer agree|the relayer is the pool writer/));
  test("HOLD missing after a proven exit 3 => FAIL", () => expectFail("duplicate-fence", { holdNotWritten: true }, /gs-exit-hold wrote the HOLD/));
  test("HOLD missing after a proven exit 5 => FAIL", () => expectFail("duplicate-fence", { holdNotWritten: true, fenceStatus: 5 }, /gs-exit-hold wrote the HOLD/));
  test("HOLD cleared without deploy / rollback => FAIL", () => expectFail("duplicate-fence", { holdVanishes: true }, /HOLD/));
  test("a refused deploy that clears the HOLD => FAIL", () => expectFail("duplicate-fence", { refusedDeployClears: true }, /a refused deploy keeps the HOLD/));
  test("reboot with HOLD and process running => FAIL", () => expectFail("duplicate-fence", { processAfterRebootWithHold: true }, /no server process after the reboot|the service settled down/));
  test("a server process that ran only briefly after a reboot on HOLD => FAIL (an invariant over every observation)", () => expectFail("duplicate-fence", { transientProcessAfterReboot: true }, /no server process after the reboot/));
  test("the rival never fences the incumbent (two writers) => FAIL", () => expectFail("duplicate-fence", { noFence: true }, /the incumbent was fenced/));
  test("ExecStopPost without EXIT_CODE / EXIT_STATUS => FAIL (COST-1's assumption broken)", () => expectFail("duplicate-fence", { exitVarsUnset: true }, /passes EXIT_CODE/));
  test("cleanup failure => overall FAIL even when every other check passed", () => expectFail("graceful-stop", { cleanupFails: true }, /cleanup: the recorder removed/));
  test("an ordinary crash is distinct from a fence: a fence-status exit in crash-restart => FAIL", () => expectFail("crash-restart", { crashStatus: 3 }, /an ordinary crash/));
  test("graceful stop that does not exit 0 => FAIL", () => expectFail("graceful-stop", { stopStatus: 143 }, /exited 0/));

  test("REVIEW R1: an unexpected fence exit in F7 / F8 is NEVER cleared by the drill (no gs-deploy over a HOLD it did not cause)", async () => {
    for (const [scenario, faults] of [["crash-restart", { crashStatus: 3 }], ["graceful-stop", { stopStatus: 3 }], ["graceful-stop", { stopStatus: 5 }]] as const) {
      const { result, world } = await drill(scenario, faults);
      assert.equal(result.verdict, "FAIL", show(result));
      const host = world.hosts.get(INSTANCE);
      assert.ok(host !== undefined && host.hold !== null, `${scenario}: the HOLD is kept`);
      assert.ok(!host.log.includes("deploy"), `${scenario}: no gs-deploy ran (${host.log.join(",")})`);
      assert.ok(failing(result, /gs-deploy allowed/));
    }
  });
  test("REVIEW R4: the rival could not be removed => no gs-deploy beside it (scenario and cleanup), FAIL", async () => {
    const { result, world } = await drill("duplicate-fence", { rivalStopFails: true });
    assert.equal(result.verdict, "FAIL", show(result));
    const host = world.hosts.get(INSTANCE);
    assert.ok(host !== undefined && !host.log.includes("deploy") && !host.log.includes("deploy-refused-probe"), host?.log.join(","));
    assert.ok(host !== undefined && host.hold !== null, "the HOLD is kept");
  });
  test("REVIEW R2: a docker read that failed is UNKNOWN, never 'no container'", () => {
    const lines = ["K boot_id b", "K os_id amzn", "K os_version_id 2023", "K systemd_version systemd 252", "K instance_id i-0123456789abcdef0", "K public_ip 1.1.1.1", "K expected_ip 1.1.1.1", "K environment staging", "K release_digest d", "K release_build b", "K hold absent", "K readyz 000", "K docker failed", ...["ActiveState=failed", "SubState=failed", "Result=exit-code", "ExecMainCode=1", "ExecMainStatus=3", "NRestarts=0", "InvocationID=x", "UnitFileState=enabled"].map((p) => `P ${p}`)].map((l) => ({ tag: l[0], text: l.slice(2) }));
    const parsed = parseObservation(lines);
    assert.equal(parsed.ok, false);
    const ok = parseObservation(lines.map((l) => (l.text === "docker failed" ? { tag: "K", text: "docker ok" } : l)));
    assert.equal(ok.ok, true);
  });
  test("missing exit-status observation (recorder silent) => NOT EVALUATED, never PASS", async () => {
    const { result } = await drill("duplicate-fence", { recorderSilent: true });
    assert.notEqual(result.verdict, "PASS");
    assert.ok(allChecks(result).some((c) => c.status === "not-evaluated" && /ExecStopPost observed/.test(c.name)), show(result));
  });
  test("ambiguous exit-status observation (two stops) => NOT EVALUATED, never PASS", async () => {
    const { result } = await drill("crash-restart", { recorderTwice: true });
    assert.notEqual(result.verdict, "PASS");
    assert.ok(allChecks(result).some((c) => c.status === "not-evaluated" && /ONE exit/.test(c.name)), show(result));
  });
  test("readiness never seen 503 before the process was gone => NOT EVALUATED for that property, never PASS", async () => {
    const { result } = await drill("graceful-stop", { stopSamples: ["200", "000"] });
    assert.notEqual(result.verdict, "PASS");
    assert.ok(allChecks(result).some((c) => c.status === "not-evaluated" && /readiness goes unavailable first/.test(c.name)));
  });
  test("readiness flapping back to 200 => FAIL", () => expectFail("graceful-stop", { stopSamples: ["200", "503", "200", "000"] }, /readiness goes unavailable first/));
  test("the drill lock lost mid-drill (reclaimed by another operator) => mutations stop, FAIL, cleanup still runs", async () => {
    const table = fakeTable();
    table.stealAfterPuts = 2;
    const { result, world } = await drill("crash-restart", {}, () => undefined, {}, undefined, table);
    assert.equal(result.verdict, "FAIL", show(result));
    assert.ok(failing(result, /the drill lock is still this run's/));
    assert.ok(!(world.hosts.get(INSTANCE)?.log ?? []).includes("kill-container"), "no mutation after the lock was lost");
    /* Review R3: with the lock reclaimed by another run, cleanup makes NO change (it would act inside another drill). */
    assert.ok(failing(result, /cleanup: the recorder removed/));
    assert.ok(!(world.hosts.get(INSTANCE)?.log ?? []).includes("recorder-remove") && !(world.hosts.get(INSTANCE)?.log ?? []).includes("deploy"));
  });
  test("a read failure of a mutation step => NOT EVALUATED (and cleanup still runs)", async () => {
    const { result, world } = await drill("crash-restart", { transportFails: new Set(["kill-container"]) });
    assert.equal(result.verdict, "NOT EVALUATED", show(result));
    assert.ok(allChecks(result).some((c) => c.status === "not-evaluated" && /docker kill/.test(c.name)));
    assert.equal(world.hosts.get(INSTANCE)?.dropIns.length, 0, "cleanup removed the recorder");
  });
  test("a truncated observation (no END line) is never read as complete => NOT EVALUATED", async () => {
    const { result } = await drill("graceful-stop", { truncateObserveFrom: 3 });
    assert.notEqual(result.verdict, "PASS");
    assert.ok(nonPass(result).some((c) => c.status === "not-evaluated" && !OFFLINE_ONLY.test(c.name)), show(result));
  });
  test("an unreadable control plane => refused (nothing mutated)", async () => {
    const { result, world } = await drill("crash-restart", { authorityUnavailable: true });
    assert.equal(result.refused, true);
    assert.equal(result.verdict, "NOT EVALUATED");
    assert.ok(!(world.hosts.get(INSTANCE)?.log ?? []).some((k) => k !== "observe" && k !== "observe-unit"), "no mutation");
  });
});

/* ================================================================== */
describe("COST-2C: the live-safety contract REFUSES before any mutation", () => {
  const refused = async (d: Drilled) => {
    assert.equal(d.result.refused, true, show(d.result));
    assert.equal(d.result.verdict, "NOT EVALUATED");
    const log = [...d.world.hosts.values()].flatMap((h) => h.log);
    assert.deepEqual(log.filter((k) => k !== "observe" && k !== "observe-unit"), [], "no host operation but observations");
    const lock = await readLock(d.table.client, GAME_TABLE);
    assert.ok(lock.state !== "ok" || lock.holder.outcome !== "held" || lock.holder.run !== RUN, "a refused run never keeps the lock");
  };
  test("money game present => disruptive drills refused", async () => {
    for (const s of ["crash-restart", "reboot-restart", "duplicate-fence", "replacement-before"] as const) {
      const d = await drill(s, {}, (_w, t) => addMoneyGame(t, "k".repeat(64), "g-1"));
      await refused(d);
      assert.ok(failing(d.result, /no open money game/));
    }
  });
  test("money present does not refuse F7 / F9a (not money-disruptive drills); it is recorded", async () => {
    const d = await drill("duplicate-preflight", {}, (_w, t) => addMoneyGame(t, "k".repeat(64), "g-1"));
    assert.equal(d.result.refused, false, show(d.result));
  });
  test("RELAYQ nonempty => refused", async () => refused(await drill("duplicate-fence", {}, (w) => (w.cp.relayq = 2))));
  test("wrong environment (the document is production) => refused", async () => refused(await drill("graceful-stop", {}, () => undefined, {}, undefined, undefined, { environment: "production" })));
  test("mainnet escrow => refused", async () => refused(await drill("graceful-stop", {}, () => undefined, {}, undefined, undefined, { escrowNetwork: "mainnet" })));
  test("APPGEN not the expected generation => refused", async () => refused(await drill("crash-restart", {}, (w) => (w.cp.appgen = 2))));
  test("routing names another pool => refused", async () => refused(await drill("crash-restart", {}, (w) => (w.cp.routing = { primary_pool: "p2", routing_version: 2 }))));
  test("two hosts => refused", async () => refused(await drill("crash-restart", {}, (w) => w.instances.push({ instanceId: NEW_INSTANCE, state: "running", publicIp: null, launchTime: null }))));
  test("the EIP is another instance's => refused", async () => refused(await drill("crash-restart", {}, (w) => (w.eipOwner = NEW_INSTANCE))));
  test("an ECS task still runs => refused", async () => refused(await drill("crash-restart", {}, (w) => (w.ecs = 1))));
  test("a HOLD already present => refused", async () => refused(await drill("crash-restart", {}, (w) => ((w.hosts.get(INSTANCE) as { hold: string | null }).hold = "exit 3 at x"))));
  test("another writer than the host's process => refused", async () => refused(await drill("crash-restart", { foreignWriter: true })));
  test("another release than --digest => refused", async () => refused(await drill("crash-restart", {}, () => undefined, { digest: `sha256:${"b".repeat(64)}` })));
  test("a host script that is not the reviewed bytes => refused", async () => {
    const world = new FakeWorld({});
    const tampered = { ...FILES, "gs-exit-hold": "0".repeat(64) };
    const d = await drill("crash-restart", {}, (w) => (w.expectedFiles = FILES), {}, world);
    assert.equal(d.result.refused, false);
    /* The check itself: */
    const lines = parseHostOutput(world.hosts.get(INSTANCE)?.run({ kind: "observe-unit", run: RUN }, world) ?? "", { kind: "observe-unit", run: RUN });
    assert.ok(lines.ok);
    if (lines.ok) assert.ok(judgeUnit("u", lines.lines, tampered).some((c) => c.status === "fail" && /gs-exit-hold is the reviewed file/.test(c.name)));
  });
  test("concurrent drill lock => refused (the holder is named)", async () => {
    const table = fakeTable();
    const held = await acquireLock(table.client, GAME_TABLE, { run: "other-run-1", scenario: "duplicate-fence", instance: INSTANCE, operator: "x", sourceCommit: COMMIT, leaseMs: 3_600_000, now: Date.parse("2026-10-02T21:59:00Z"), reclaim: null });
    assert.equal(held.kind, "held");
    const d = await drill("crash-restart", {}, () => undefined, {}, undefined, table);
    await refused(d);
    assert.ok(failing(d.result, /the drill lock/));
    assert.match(nonPass(d.result)[0].detail, /other-run-1/);
  });
});

/* ================================================================== */
describe("COST-2C: the replacement (stale host) certification", () => {
  const replacement = async (faults: Faults, keepOld: "terminated" | "running", stale: string | null) => {
    const world = new FakeWorld(faults);
    const table = fakeTable();
    const before = await drill("replacement-before", faults, () => undefined, {}, world, table);
    assert.equal(before.result.refused, false, show(before.result));
    assert.notEqual(before.result.verdict, "FAIL", show(before.result));
    const lock = await readLock(table.client, GAME_TABLE);
    assert.ok(lock.state === "ok" && lock.holder.outcome === "held", "replacement-before keeps the lock across the replacement");
    const b = (before.result.record.facts as { replacement_baseline: ReplacementBaseline }).replacement_baseline;
    world.replaceHost(keepOld);
    world.t += 60_000;
    const after = await drill("replacement-after", faults, () => undefined, { instanceId: NEW_INSTANCE, replacementBefore: b, staleInstanceId: stale }, world, table);
    return after;
  };
  test("a reachable stale host: preflight refused (not the serving EIP), serves nothing, no reacquisition; newer epochs; only the AL2023 item open", async () => {
    const after = await replacement({}, "running", INSTANCE);
    assert.equal(after.result.refused, false, show(after.result));
    assert.deepEqual(nonPass(after.result).map((c) => c.name).filter((n) => !OFFLINE_ONLY.test(n)), [], show(after.result));
    const lock = await readLock(after.table.client, GAME_TABLE);
    assert.ok(lock.state === "ok" && lock.holder.outcome === "released");
  });
  test("the old host terminated and no stale host declared: the stale-host proof is NOT EVALUATED (never assumed)", async () => {
    const after = await replacement({}, "terminated", null);
    assert.equal(after.result.verdict, "NOT EVALUATED");
    assert.ok(nonPass(after.result).some((c) => /stale host's preflight refuses/.test(c.name) && c.status === "not-evaluated"));
  });
  test("stale host still serving => FAIL", async () => {
    const after = await replacement({ staleServing: true }, "running", INSTANCE);
    assert.equal(after.result.verdict, "FAIL", show(after.result));
    assert.ok(failing(after.result, /stale host serves nothing/));
  });
  test("stale host still holding the EIP (its preflight would pass) => FAIL", async () => {
    const after = await replacement({ staleHoldsEip: true }, "running", INSTANCE);
    assert.equal(after.result.verdict, "FAIL", show(after.result));
  });
  test("two hosts (the old one running, undeclared) => FAIL", async () => {
    const after = await replacement({}, "running", null);
    assert.equal(after.result.verdict, "FAIL", show(after.result));
    assert.ok(failing(after.result, /exactly one single-host instance|no second running host/));
  });
});

/* ================================================================== */
describe("COST-2C: the exit contract judge (pure) and gs-exit-hold's own HOLD law", () => {
  const state = (exits: string[], hold: string | null, props: Record<string, string> = {}, journal: string[] = []): HostState => ({
    bootId: "b",
    osId: "amzn",
    osVersionId: "2023",
    systemdVersion: "systemd 252",
    systemdMajor: 252,
    instanceId: INSTANCE,
    publicIp: EIP,
    expectedIp: EIP,
    environment: "staging",
    releaseDigest: DIGEST,
    releaseBuild: BUILD,
    hold: { present: hold !== null, text: hold },
    readyz: "000",
    nowMs: 1,
    props: { ActiveState: "failed", SubState: "failed", Result: "exit-code", ExecMainCode: "1", ExecMainStatus: "3", NRestarts: "0", InvocationID: "x", UnitFileState: "enabled", ...props },
    docker: "ok",
    containers: [],
    exits: exits.map((x) => parseExit(x) as NonNullable<ReturnType<typeof parseExit>>),
    dropIns: [],
    journal,
    banners: [],
    withheld: 0,
  });
  const exitLine = (code: string, status: string, set = "yes") => `EXIT_CODE_SET=${set} EXIT_CODE=${code} EXIT_STATUS_SET=${set} EXIT_STATUS=${status} SERVICE_RESULT=exit-code AT_MS=1759442400000 BOOT=b`;
  const sys = (code: string, status: string) => `1759442400.000000 h systemd[1]: gs-server.service: Main process exited, code=${code}, status=${status}/n/a`;
  const v = (c: CertCheck[]) => verdictOf(c);

  test("graceful exit 0 => no HOLD expected (PASS without HOLD, FAIL with one)", () => {
    assert.equal(v(judgeExit("x", state([exitLine("exited", "0")], null, { ExecMainStatus: "0" }, [sys("exited", "0")]), 0, { kind: "graceful" }).checks), "PASS");
    assert.equal(v(judgeExit("x", state([exitLine("exited", "0")], "exit 3 at t", { ExecMainStatus: "0" }, [sys("exited", "0")]), 0, { kind: "graceful" }).checks), "FAIL");
  });
  test("exit 3 => HOLD expected; exit 5 => HOLD expected", () => {
    for (const st of ["3", "5"]) {
      assert.equal(v(judgeExit("x", state([exitLine("exited", st)], `exit ${st} at t`, { ExecMainStatus: st }, [sys("exited", st)]), 0, { kind: "fence" }).checks), "PASS", st);
      assert.equal(v(judgeExit("x", state([exitLine("exited", st)], null, { ExecMainStatus: st }, [sys("exited", st)]), 0, { kind: "fence" }).checks), "FAIL", `${st} without HOLD`);
    }
  });
  test("an unrelated exit => HOLD NOT expected", () => {
    for (const st of ["1", "2", "4", "137", "143"]) {
      assert.equal(expectedHold("exited", st), false);
      assert.equal(v(judgeExit("x", state([exitLine("exited", st)], null, {}, [sys("exited", st)]), 0, { kind: "crash" }).checks), "PASS", st);
      assert.equal(v(judgeExit("x", state([exitLine("exited", st)], `exit ${st} at t`, {}, [sys("exited", st)]), 0, { kind: "crash" }).checks), "FAIL", `${st} with a HOLD`);
    }
    assert.equal(expectedHold("killed", "3"), false, "a signal named 3 is not an exit status 3");
  });
  test("missing / ambiguous observation => NOT EVALUATED; unset variables => FAIL", () => {
    assert.equal(v(judgeExit("x", state([], null), 0, { kind: "fence" }).checks), "NOT EVALUATED");
    assert.equal(v(judgeExit("x", state([exitLine("exited", "3"), exitLine("exited", "3")], "exit 3 at t"), 0, { kind: "fence" }).checks), "NOT EVALUATED");
    assert.equal(v(judgeExit("x", state([exitLine("", "", "")], null), 0, { kind: "fence" }).checks), "FAIL");
    assert.equal(v(judgeExit("x", state([exitLine("exited", "3")], "exit 3 at t"), 0, { kind: "fence" }).checks), "NOT EVALUATED", "no journal line: not every source agrees yet");
  });
  test("crash and fence are distinct: a crash judged as a fence FAILS, a fence judged as a crash FAILS", () => {
    assert.equal(v(judgeExit("x", state([exitLine("exited", "137")], null, { ExecMainStatus: "137" }, [sys("exited", "137")]), 0, { kind: "fence" }).checks), "FAIL");
    assert.equal(v(judgeExit("x", state([exitLine("exited", "3")], "exit 3 at t", {}, [sys("exited", "3")]), 0, { kind: "crash" }).checks), "FAIL");
  });
  test("the journal and ExecStopPost disagreeing => FAIL", () => {
    assert.equal(v(judgeExit("x", state([exitLine("exited", "3")], "exit 3 at t", {}, [sys("exited", "0")]), 0, { kind: "fence" }).checks), "FAIL");
  });

  test("PARITY: expectedHold is exactly what the real gs-exit-hold script writes (bash, every case)", { skip: NO_BASH }, () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-bin-"));
    const script = lfCopy("infra/aws/modules/single-host/files/bin/gs-exit-hold", binDir);
    lfCopy("infra/aws/modules/single-host/files/bin/gs-lib.sh", binDir);
    const cases: Array<[string | undefined, string | undefined]> = [["exited", "3"], ["exited", "5"], ["exited", "0"], ["exited", "1"], ["exited", "137"], ["killed", "3"], ["killed", "KILL"], ["dumped", "5"], [undefined, undefined], ["exited", undefined], [undefined, "3"], ["exited", "03"], ["exited", "35"]];
    for (const [code, status] of cases) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-hold-"));
      const env: Record<string, string> = { PATH: process.env.PATH ?? "", GS_STATE_DIR: posix(dir) };
      if (code !== undefined) env.EXIT_CODE = code;
      if (status !== undefined) env.EXIT_STATUS = status;
      const r = bash([posix(script)], { env });
      assert.equal(r.status, 0, r.stderr);
      const written = fs.existsSync(path.join(dir, "hold"));
      assert.equal(written, expectedHold(code ?? "", status ?? ""), `EXIT_CODE=${String(code)} EXIT_STATUS=${String(status)}`);
      if (written) assert.match(fs.readFileSync(path.join(dir, "hold"), "utf8"), new RegExp(`^exit ${status} at `));
      fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.rmSync(binDir, { recursive: true, force: true });
  });
});

/* ================================================================== */
describe("COST-2C: the drill lock", () => {
  const T0 = Date.parse("2026-10-02T20:00:00Z");
  const base = { scenario: "crash-restart", instance: INSTANCE, operator: "a", sourceCommit: COMMIT, leaseMs: 3_600_000, reclaim: null };
  test("acquire, refuse a second holder, renew, release, re-acquire", async () => {
    const t = fakeTable();
    const a = await acquireLock(t.client, GAME_TABLE, { ...base, run: "run-aaaaaa", now: T0 });
    assert.equal(a.kind, "held");
    const b = await acquireLock(t.client, GAME_TABLE, { ...base, run: "run-bbbbbb", now: T0 + 1 });
    assert.equal(b.kind, "refused");
    if (a.kind !== "held") return;
    const r = await renewLock(t.client, GAME_TABLE, a.holder, T0 + 10, 3_600_000);
    assert.equal(r.kind, "held");
    const rel = await releaseLock(t.client, GAME_TABLE, a.holder, T0 + 20, "done");
    assert.equal(rel.kind, "held");
    assert.equal((await acquireLock(t.client, GAME_TABLE, { ...base, run: "run-bbbbbb", now: T0 + 30 })).kind, "held");
    assert.equal((await releaseLock(t.client, GAME_TABLE, a.holder, T0 + 40, "again")).kind, "refused", "a released claim cannot release someone else's lock");
  });
  test("an EXPIRED lock is never taken silently; reclaim needs the exact run, and the lease ended beyond the skew", async () => {
    const t = fakeTable();
    const a = await acquireLock(t.client, GAME_TABLE, { ...base, run: "run-aaaaaa", now: T0, leaseMs: 60_000 });
    assert.equal(a.kind, "held");
    const late = T0 + 60_000 + CLOCK_SKEW_MS + 1;
    const plain = await acquireLock(t.client, GAME_TABLE, { ...base, run: "run-bbbbbb", now: late });
    assert.equal(plain.kind, "refused");
    assert.match((plain as { detail: string }).detail, /--reclaim-stale-lock run-aaaaaa/);
    assert.equal((await acquireLock(t.client, GAME_TABLE, { ...base, run: "run-bbbbbb", now: late, reclaim: "run-zzzzzz" })).kind, "refused", "wrong holder named");
    assert.equal((await acquireLock(t.client, GAME_TABLE, { ...base, run: "run-bbbbbb", now: T0 + 60_000 + CLOCK_SKEW_MS - 1, reclaim: "run-aaaaaa" })).kind, "refused", "within the skew: not stale");
    const re = await acquireLock(t.client, GAME_TABLE, { ...base, run: "run-bbbbbb", now: late, reclaim: "run-aaaaaa" });
    assert.equal(re.kind, "held");
    if (a.kind === "held") {
      assert.equal((await renewLock(t.client, GAME_TABLE, a.holder, late + 1, 60_000)).kind, "refused", "the reclaimed run stops (its renew fails)");
      assert.equal((await releaseLock(t.client, GAME_TABLE, a.holder, late + 1, "x")).kind, "refused");
    }
  });
  test("racing acquires: exactly one wins", async () => {
    const t = fakeTable();
    const all = await Promise.all(["run-1aaaaa", "run-2aaaaa", "run-3aaaaa", "run-4aaaaa"].map((run) => acquireLock(t.client, GAME_TABLE, { ...base, run, now: T0 })));
    assert.equal(all.filter((x) => x.kind === "held").length, 1);
  });
  test("a lost answer is settled by reading back; an unreadable lock item or an unavailable table is UNKNOWN (refused)", async () => {
    const t = fakeTable();
    t.loseNextAnswer = true;
    assert.equal((await acquireLock(t.client, GAME_TABLE, { ...base, run: "run-aaaaaa", now: T0 })).kind, "held");
    const u = fakeTable();
    u.items.set(`${LOCK_PK}|LOCK`, { pk: { S: LOCK_PK }, sk: { S: "LOCK" }, fmt: { N: "9" } });
    assert.equal((await acquireLock(u.client, GAME_TABLE, { ...base, run: "run-aaaaaa", now: T0 })).kind, "unknown");
    const d = fakeTable();
    d.down = true;
    assert.equal((await acquireLock(d.client, GAME_TABLE, { ...base, run: "run-aaaaaa", now: T0 })).kind, "unknown");
  });
  test("the lease is bounded", async () => {
    const t = fakeTable();
    assert.equal((await acquireLock(t.client, GAME_TABLE, { ...base, run: "run-aaaaaa", now: T0, leaseMs: 7 * 3_600_000 })).kind, "refused");
    assert.equal((await acquireLock(t.client, GAME_TABLE, { ...base, run: "run-aaaaaa", now: T0, leaseMs: 1_000 })).kind, "refused");
  });
});

/* ================================================================== */
describe("COST-2C: the control-plane readings never collapse an unknown", () => {
  test("open money: none / open / unknown (damaged FINKEYS, unavailable table)", async () => {
    const t = fakeTable();
    assert.deepEqual(await openMoneyState(t.client, GAME_TABLE), { state: "none" });
    addMoneyGame(t, "a".repeat(64), "g-1");
    assert.deepEqual(await openMoneyState(t.client, GAME_TABLE), { state: "open", count: 1 });
    t.items.set("FINKEYS|FINKEYS", { pk: { S: "FINKEYS" }, sk: { S: "FINKEYS" }, keys: { S: "not-a-set" } });
    assert.equal((await openMoneyState(t.client, GAME_TABLE)).state, "unknown");
    t.down = true;
    assert.equal((await openMoneyState(t.client, GAME_TABLE)).state, "unknown");
  });
  test("an ABSENT role is a FAIL, an UNAVAILABLE read is NOT EVALUATED -- never the expected holder", async () => {
    const world = new FakeWorld({});
    const t = fakeTable();
    const readers = world.cp.readers();
    const target = { clients: { app: t.client, ledger: t.client }, tables: { game: "g", identity: "i", ledger: "l" }, pool: "p1", relayer: RELAYER };
    const expect = { label: "w", pool: "p1", environment: "staging", generation: 1, task: "t-0000000000000001", requireReady: true, now: world.t };
    assert.equal(verdictOf(judgeSingleWriter(await readAuthority(readers, target, () => world.t), expect)), "PASS");
    const absent = await readAuthority({ ...readers, identityRole: async () => null }, target, () => world.t);
    assert.equal(verdictOf(judgeSingleWriter(absent, expect)), "FAIL");
    const down = await readAuthority({ ...readers, identityRole: async () => { throw Object.assign(new Error("x"), { name: "ThrottlingException" }); } }, target, () => world.t);
    assert.equal(verdictOf(judgeSingleWriter(down, expect)), "NOT EVALUATED");
    const damaged = await readAuthority({ ...readers, identityRole: async () => { throw Object.assign(new Error("x"), { name: "IdentityStoreCorruptError" }); } }, target, () => world.t);
    assert.equal(verdictOf(judgeSingleWriter(damaged, expect)), "FAIL");
    const noReaders = await readAuthority(undefined, target, () => world.t);
    assert.equal(verdictOf(judgeSingleWriter(noReaders, expect)), "NOT EVALUATED");
  });
  test("an unknown money or queue state REFUSES (never taken for none / empty)", async () => {
    const world = new FakeWorld({});
    const t = fakeTable();
    t.down = true;
    const snap = await readAuthority(world.cp.readers(), { clients: { app: t.client, ledger: t.client }, tables: { game: "g", identity: "i", ledger: "l" }, pool: "p1", relayer: RELAYER }, () => 1);
    assert.equal(verdictOf(judgeQuiet(snap, { money: true, relayQueue: true })), "FAIL");
  });
});

/* ================================================================== */
describe("COST-2C: the host framing, the templates (real bash against stubs) and the transport", () => {
  const frame = (op: { kind: string; run: string }, body: string[]): string => {
    const text = body.length === 0 ? "" : `${body.join("\n")}\n`;
    return [`${HOST_FRAME} BEGIN ${op.kind} ${op.run}`, ...body, `${HOST_FRAME} END ${op.kind} ${op.run} ${body.length} ${require("crypto").createHash("sha256").update(text).digest("hex")}`].join("\n");
  };
  test("a complete answer parses; truncated, altered, foreign or doubled answers are refused", () => {
    const op = { kind: "observe" as const, run: RUN };
    const good = frame(op, ["K a 1", "K b 2"]);
    assert.ok(parseHostOutput(good, op).ok);
    assert.ok(!parseHostOutput(good.split("\n").slice(0, 2).join("\n"), op).ok, "truncated");
    assert.ok(!parseHostOutput(good.replace("K b 2", "K b 3"), op).ok, "altered");
    assert.ok(!parseHostOutput(good, { kind: "observe", run: "another-run" }).ok, "another run's");
    assert.ok(!parseHostOutput(`${good}\n${good}`, op).ok, "two answers");
    assert.ok(!parseHostOutput(frame({ kind: "stop", run: RUN }, ["E 0"]), op).ok, "another operation's");
  });
  test("every template is valid bash; no unvalidated value reaches one", { skip: NO_BASH }, () => {
    const ops: HostOp[] = [
      { kind: "observe", run: RUN, sinceEpochSeconds: 1_759_400_000 },
      { kind: "observe-unit", run: RUN },
      { kind: "recorder-install", run: RUN },
      { kind: "recorder-remove", run: RUN },
      { kind: "stop", run: RUN },
      { kind: "deploy", run: RUN, digest: DIGEST, build: BUILD },
      { kind: "deploy-refused-probe", run: RUN, build: BUILD },
      { kind: "kill-container", run: RUN },
      { kind: "reboot", run: RUN },
      { kind: "preflight-probe", run: RUN },
      { kind: "start-attempt", run: RUN },
      { kind: "rival-start", run: RUN },
      { kind: "rival-stop", run: RUN },
    ];
    assert.deepEqual(ops.map((o) => o.kind).sort(), [...HOST_OP_KINDS].sort());
    for (const op of ops) {
      const r = bash(["-n"], { input: hostScript(op) });
      assert.equal(r.status, 0, `${op.kind}: ${r.stderr}`);
      const line = ssmCommandLine(op);
      assert.ok(/^f="\$\(mktemp\)" && printf '%s' '[A-Za-z0-9+/=]+' \| base64 -d >"\$f" && bash "\$f"; rc=\$\?; rm -f "\$f"; exit \$rc$/.test(line), op.kind);
    }
    assert.equal(bash(["-n"], { input: recorderScript() }).status, 0);
    for (const bad of [{ kind: "observe-unit", run: "x; rm -rf /" }, { kind: "observe-unit", run: "UPPER-case" }, { kind: "deploy", run: RUN, digest: "sha256:$(id)", build: BUILD }, { kind: "deploy", run: RUN, digest: DIGEST, build: "a b" }, { kind: "deploy", run: RUN, digest: `sha256:${"0".repeat(64)}`, build: BUILD }, { kind: "observe", run: RUN, sinceEpochSeconds: 1.5 }, { kind: "nope", run: RUN }]) {
      assert.throws(() => hostScript(bad as HostOp), JSON.stringify(bad));
    }
  });

  /** A stub host: systemctl / docker / curl / journalctl on PATH, the directories under a temp root. */
  const stubHost = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gs-cert-host-"));
    const bin = path.join(root, "stubs");
    for (const d of ["stubs", "etc", "state", "cert", "dropin"]) fs.mkdirSync(path.join(root, d), { recursive: true });
    fs.writeFileSync(path.join(root, "etc/host.env"), `GS_ENVIRONMENT=staging\nGS_EXPECTED_PUBLIC_IP=${EIP}\nGS_CONTAINER_PORT=8917\n`);
    fs.writeFileSync(path.join(root, "etc/release.env"), `GS_IMAGE_DIGEST=${DIGEST}\nBUILD_ID=${BUILD}\nGS_MEASURE=0\n`);
    const w = (name: string, text: string) => fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${text}\n`, { mode: 0o755 });
    w("systemctl", `case "$1" in
  --version) echo "systemd 252 (252.23-2.amzn2023)"; echo "+PAM" ;;
  daemon-reload) echo reload >>"$STUB_LOG" ;;
  show)
    if printf '%s ' "$@" | grep -q -- '--value'; then echo "@1759442000"; exit 0; fi
    printf '%s\\n' ActiveState=active SubState=running Result=success ExecMainCode=0 ExecMainStatus=0 ExecMainPID=4242 NRestarts=0 UnitFileState=enabled InvocationID=abc ExecMainStartTimestamp=@1759442000 ExecMainExitTimestamp= Restart=on-failure 'RestartPreventExitStatus=3 5' 'ExecStopPost={ path=/opt/gs/bin/gs-exit-hold ; argv[]=/opt/gs/bin/gs-exit-hold ; ignore_errors=no }' DropInPaths= ;;
esac`);
    w("docker", `case "$1" in ps) echo "gs-server|running|reg/gs@${DIGEST}|${"c".repeat(64)}" ;; container) [ "$2" = inspect ] && { echo running; exit 0; } ;; esac`);
    w("curl", `for a in "$@"; do case "$a" in */api/token) echo tok; exit 0 ;; */instance-id) echo ${INSTANCE}; exit 0 ;; */public-ipv4) echo ${EIP}; exit 0 ;; */gs/readyz) printf 200; exit 0 ;; esac; done; exit 7`);
    w("journalctl", `cat <<'EOF'
1759442001.000000 ip-10 systemd[1]: Started gs-server.service - 18Cosmos single host: game server (AWS storage mode).
1759442002.000000 ip-10 gs-preflight[11]: gs: preflight passed: build ${BUILD}
1759442003.000000 ip-10 gs-run[12]:   storage: DynamoDB (game ${GAME_TABLE}, identity gs-staging-identity, ledger arn:aws:dynamodb:us-east-1:111111111111:table/ledger); pool p1, generation 1, task t-00000000000000aa
1759442004.000000 ip-10 gs-run[12]: {"_aws":{"CloudWatchMetrics":[]},"HostHealthProblems":0}
1759442005.000000 ip-10 systemd[1]: gs-server.service: Main process exited, code=exited, status=3/NOTIMPLEMENTED
EOF`);
    const hostBin = path.join(root, "bin");
    fs.mkdirSync(hostBin);
    for (const name of ["gs-lib.sh", "gs-preflight", "gs-run", "gs-exit-hold", "gs-deploy", "gs-rollback", "gs-stop", "gs-health"]) lfCopy(`infra/aws/modules/single-host/files/bin/${name}`, hostBin);
    const unit = lfCopy("infra/aws/modules/single-host/files/systemd/gs-server.service", root);
    const env = { PATH: `${posix(bin)}${PATH_SEP}${process.env.PATH ?? ""}`, GS_ETC: posix(path.join(root, "etc")), GS_STATE_DIR: posix(path.join(root, "state")), GS_CERT_DIR: posix(path.join(root, "cert")), GS_DROPIN_DIR: posix(path.join(root, "dropin")), GS_UNIT_FILE: posix(unit), GS_BIN: posix(hostBin), GS_IMDS: "http://imds.test", STUB_LOG: posix(path.join(root, "log")) };
    return { root, env, run: (op: HostOp) => bash(["-c", hostScript(op)], { env }), done: () => fs.rmSync(root, { recursive: true, force: true }) };
  };

  test("observe: the real template's output parses into a state (journal filtered to systemd and gs: lines; the banner's task only)", { skip: NO_BASH }, () => {
    const h = stubHost();
    try {
      const op: HostOp = { kind: "observe", run: RUN, sinceEpochSeconds: 1_759_440_000 };
      const r = h.run(op);
      assert.equal(r.status, 0, r.stderr);
      const parsed = parseHostOutput(r.stdout, op);
      assert.ok(parsed.ok, parsed.ok ? "" : parsed.problem);
      if (!parsed.ok) return;
      const s = parseObservation(parsed.lines);
      assert.ok(s.ok, s.ok ? "" : s.problem);
      if (!s.ok) return;
      assert.equal(s.state.instanceId, INSTANCE);
      assert.equal(s.state.readyz, "200");
      assert.equal(s.state.hold.present, false);
      assert.equal(s.state.releaseDigest, DIGEST);
      assert.deepEqual(s.state.banners.map((b) => b.task), ["t-00000000000000aa"]);
      assert.ok(s.state.journal.some((l) => /Main process exited, code=exited, status=3/.test(l)));
      assert.ok(!s.state.journal.some((l) => /CloudWatchMetrics|storage: DynamoDB/.test(l)), "the server's own output never enters the evidence");
      assert.ok(!r.stdout.includes("tok"), "the IMDS token is never printed");
      fs.writeFileSync(path.join(h.env.GS_STATE_DIR, "hold"), "exit 3 at 2026-10-02T22:00:00Z\n");
      const again = parseHostOutput(h.run(op).stdout, op);
      assert.ok(again.ok);
      if (again.ok) {
        const s2 = parseObservation(again.lines);
        assert.ok(s2.ok && s2.state.hold.present && s2.state.hold.text === "exit 3 at 2026-10-02T22:00:00Z");
      }
    } finally {
      h.done();
    }
  });
  test("observe-unit: the reviewed unit and scripts hash to the repository's (the host's copy is compared byte for byte)", { skip: NO_BASH }, () => {
    const h = stubHost();
    try {
      const op: HostOp = { kind: "observe-unit", run: RUN };
      const parsed = parseHostOutput(h.run(op).stdout, op);
      assert.ok(parsed.ok);
      if (parsed.ok) assert.equal(verdictOf(judgeUnit("u", parsed.lines, FILES)), "PASS", JSON.stringify(judgeUnit("u", parsed.lines, FILES).filter((c) => c.status !== "pass")));
    } finally {
      h.done();
    }
  });
  test("recorder: install adds ONE drop-in after gs-exit-hold (and refuses beside another drill's); the recorder writes what systemd passed; remove leaves nothing", { skip: NO_BASH }, () => {
    const h = stubHost();
    try {
      const install: HostOp = { kind: "recorder-install", run: RUN };
      const i = parseHostOutput(h.run(install).stdout, install);
      assert.ok(i.ok && i.lines.some((l) => l.tag === "E" && l.text === "0"), JSON.stringify(i));
      const dropIn = fs.readFileSync(path.join(h.env.GS_DROPIN_DIR, `90-gs-cert-${RUN}.conf`), "utf8");
      assert.equal(dropIn, `[Service]\nExecStopPost=-/bin/bash ${h.env.GS_CERT_DIR}/record-exit ${RUN}\n`);
      assert.ok(!/Restart|gs-exit-hold|hold/.test(dropIn), "the drop-in changes nothing but one recorder");
      for (const [code, status] of [["exited", "3"], [undefined, undefined]] as const) {
        const env: Record<string, string> = { PATH: process.env.PATH ?? "", GS_CERT_DIR: h.env.GS_CERT_DIR, SERVICE_RESULT: "exit-code" };
        if (code !== undefined) env.EXIT_CODE = code;
        if (status !== undefined) env.EXIT_STATUS = status;
        assert.equal(bash([`${h.env.GS_CERT_DIR}/record-exit`, RUN], { env }).status, 0);
      }
      const lines = fs.readFileSync(path.join(h.env.GS_CERT_DIR, RUN, "exits"), "utf8").trim().split("\n").map(parseExit);
      assert.deepEqual(lines.map((e) => e && [e.codeSet, e.code, e.statusSet, e.status]), [[true, "exited", true, "3"], [false, "", false, ""]]);
      assert.ok(!fs.existsSync(path.join(h.env.GS_STATE_DIR, "hold")), "the recorder never writes the HOLD");
      fs.writeFileSync(path.join(h.env.GS_DROPIN_DIR, "90-gs-cert-other-run1.conf"), "x");
      const blocked = parseHostOutput(h.run({ kind: "recorder-install", run: "another-run9" }).stdout, { kind: "recorder-install", run: "another-run9" });
      assert.ok(blocked.ok && blocked.lines.some((l) => l.tag === "E" && l.text === "91"));
      fs.rmSync(path.join(h.env.GS_DROPIN_DIR, "90-gs-cert-other-run1.conf"));
      const remove: HostOp = { kind: "recorder-remove", run: RUN };
      const rm = parseHostOutput(h.run(remove).stdout, remove);
      assert.ok(rm.ok && rm.lines.some((l) => l.tag === "E" && l.text === "0"));
      assert.ok(!fs.existsSync(path.join(h.env.GS_DROPIN_DIR, `90-gs-cert-${RUN}.conf`)) && !fs.existsSync(path.join(h.env.GS_CERT_DIR, RUN)) && !fs.existsSync(path.join(h.env.GS_CERT_DIR, "record-exit")));
    } finally {
      h.done();
    }
  });
  test("start-attempt and deploy-refused-probe refuse (exit 90, nothing run) when there is NO HOLD", { skip: NO_BASH }, () => {
    const h = stubHost();
    try {
      for (const op of [{ kind: "start-attempt", run: RUN }, { kind: "deploy-refused-probe", run: RUN, build: BUILD }] as HostOp[]) {
        const p = parseHostOutput(h.run(op).stdout, op);
        assert.ok(p.ok && p.lines.some((l) => l.tag === "E" && l.text === "90"), op.kind);
      }
      assert.ok(!fs.existsSync(h.env.STUB_LOG) || !/start/.test(fs.readFileSync(h.env.STUB_LOG, "utf8")));
    } finally {
      h.done();
    }
  });

  test("the SSM transport: send, poll until done, keep the CommandId; an undelivered command is UNKNOWN; a stub-built world is never live", async () => {
    const calls: string[][] = [];
    let polls = 0;
    const cli: AwsCli = async (args) => {
      calls.push([...args]);
      if (args[1] === "send-command") return { exitCode: 0, stdout: "12345678-1234-1234-1234-123456789012\n", stderr: "" };
      polls += 1;
      if (polls === 1) return { exitCode: 0, stdout: JSON.stringify({ Status: "InProgress" }), stderr: "" };
      return { exitCode: 0, stdout: JSON.stringify({ Status: "Success", ResponseCode: 0, StandardOutputContent: "out", StandardErrorContent: "" }), stderr: "" };
    };
    const host = createSsmHostTransport(cli, { region: "us-east-1", sleep: async () => undefined, pollMs: 1 });
    const r = await host.run(INSTANCE, { kind: "observe-unit", run: RUN });
    assert.deepEqual(r, { ok: true, exitCode: 0, stdout: "out", stderr: "", commandId: "12345678-1234-1234-1234-123456789012" });
    assert.ok(calls[0].includes("AWS-RunShellScript") && calls[0].every((a) => !/^\s*;|\|\|/.test(a)));
    const lost = createSsmHostTransport(async (args) => (args[1] === "send-command" ? { exitCode: 0, stdout: "12345678-1234-1234-1234-123456789012", stderr: "" } : { exitCode: 0, stdout: JSON.stringify({ Status: "DeliveryTimedOut" }), stderr: "" }), { region: "us-east-1", sleep: async () => undefined, pollMs: 1 });
    assert.equal((await lost.run(INSTANCE, { kind: "reboot", run: RUN })).ok, false);
    assert.equal((await host.run("not-an-instance", { kind: "reboot", run: RUN })).ok, false);
    const fleet = createCliFleetView(async (args) => (args[1] === "list-tasks" ? { exitCode: 254, stdout: "", stderr: "An error occurred (ClusterNotFoundException)" } : { exitCode: 0, stdout: JSON.stringify({ Reservations: [{ Instances: [{ InstanceId: INSTANCE, State: { Name: "running" } }] }] }), stderr: "" }), "us-east-1");
    assert.deepEqual(await fleet.ecsRunningTasks("gs-staging"), { ok: true, value: { count: 0, absent: true } });
    assert.equal((await fleet.hostInstances("staging")).ok, true);
    const world = { host, fleet, now: () => 0, sleep: async () => undefined };
    assert.equal(isLiveWorld(world), false, "a world over a stub CLI is never live");
    /* Review R5: the production world is frozen with its parts; a copy with a swapped part is not live. */
    const real = productionHostCertWorld("us-east-1", "gs-host-deploy");
    assert.equal(isLiveWorld(real), true);
    assert.ok(Object.isFrozen(real) && Object.isFrozen(real.host) && Object.isFrozen(real.fleet));
    assert.throws(() => { (real as { host: unknown }).host = host; });
    assert.equal(isLiveWorld({ ...real, host }), false);
    assert.equal(isLiveWorld({ ...real }), false);
  });
});

/* ================================================================== */
describe("COST-2C: evidence and secrets", () => {
  test("a secret-shaped host line is withheld from the evidence; the record is clean", async () => {
    const { result } = await drill("duplicate-preflight", { secretInJournal: true });
    const text = stableStringify(result.record);
    assert.ok(!/AKIA/.test(text));
    assert.deepEqual(secretFindings(text, { ownRecord: true }), []);
    assert.ok(/"withheld_lines": [1-9]/.test(text));
  });
  test("a record that WOULD carry a secret is never written (writeRecord refuses)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-ev-"));
    assert.throws(() => writeRecord(dir, "x.json", { note: "AKIAABCDEFGHIJKLMNOP" }));
    assert.ok(!fs.existsSync(path.join(dir, "x.json")));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/* ================================================================== */
describe("COST-2C: the command refuses before touching AWS; there is no --force", () => {
  const noAws: DeployDeps = {
    parameters: { get: async () => { throw new Error("SSM must not be read"); } } as never,
    dynamo: () => { throw new Error("DynamoDB must not be reached"); },
    kms: () => { throw new Error("KMS must not be reached"); },
    now: () => 0,
    out: () => undefined,
  };
  const host = { world: () => { throw new Error("no world"); }, readers: undefined, repository: REPO };
  const args = (scenario: string, over: Record<string, string> = {}, extra: string[] = []): string[] => {
    const f: Record<string, string> = { "--run-id": RUN, "--acknowledge-mutating-drill": scenario, "--environment": "staging", "--runtime-parameter": "arn:aws:ssm:us-east-1:111111111111:parameter/gs/staging/runtime/p1", "--generation": "1", "--pool": "p1", "--game-table": GAME_TABLE, "--instance-id": INSTANCE, "--digest": DIGEST, "--build": BUILD, "--source-commit": COMMIT, "--operator": "owner", "--evidence": os.tmpdir(), "--host-transport-profile": "gs-host-deploy", ...over };
    return [scenario, ...Object.entries(f).flat(), ...extra];
  };
  test("refusals: unknown scenario, ack for another scenario, non-staging, bad run id, --force, missing --before", async () => {
    const lines: string[] = [];
    const deps = { ...noAws, out: (l: string) => lines.push(l) };
    assert.equal(await hostCertCommand(["bogus"], deps, host), 2);
    assert.equal(await hostCertCommand(args("duplicate-fence", { "--acknowledge-mutating-drill": "crash-restart" }), deps, host), 2);
    assert.equal(await hostCertCommand(args("crash-restart", { "--environment": "production" }), deps, host), 2);
    assert.equal(await hostCertCommand(args("crash-restart", { "--run-id": "X" }), deps, host), 2);
    assert.equal(await hostCertCommand(args("crash-restart", {}, ["--force"]), deps, host), 2);
    assert.equal(await hostCertCommand(args("replacement-after"), deps, host), 2);
    assert.equal(await hostCertCommand(args("crash-restart", {}, ["--before", "x.json"]), deps, host), 2);
    assert.ok(lines.some((l) => /acknowledge-mutating-drill must name THIS scenario/.test(l)));
  });
  test("RECON-1: the host transport's principal is named explicitly (--host-transport-profile), or nothing runs", async () => {
    const lines: string[] = [];
    const deps = { ...noAws, out: (l: string) => lines.push(l) };
    const without = args("crash-restart").filter((a, i, all) => a !== "--host-transport-profile" && all[i - 1] !== "--host-transport-profile");
    assert.equal(await hostCertCommand(without, deps, host), 2);
    assert.ok(lines.some((l) => /--host-transport-profile/.test(l)));
    for (const bad of ["", "-x", "a b", "../p", "x".repeat(65)]) assert.equal(await hostCertCommand(args("crash-restart", { "--host-transport-profile": bad }), deps, host), 2, JSON.stringify(bad));
  });
  test("RECON-1: the production CLI runs ONLY under the named profile, with no credential variable inherited", () => {
    const env = { PATH: "/usr/bin", AWS_ACCESS_KEY_ID: "AKIAEXAMPLEEXAMPLE00", AWS_SECRET_ACCESS_KEY: "s", AWS_SESSION_TOKEN: "t", AWS_PROFILE: "gs-operator", aws_default_profile: "x", AWS_REGION: "us-east-1" };
    const call = cliInvocation("gs-host-deploy", ["ssm", "send-command", "--region", "us-east-1"], env);
    assert.deepEqual(call.argv, ["--profile", "gs-host-deploy", "ssm", "send-command", "--region", "us-east-1"]);
    for (const k of Object.keys(call.env)) assert.ok(!CREDENTIAL_ENV.includes(k.toUpperCase()), k);
    assert.equal(call.env.PATH, "/usr/bin");
    assert.equal(call.env.AWS_REGION, "us-east-1");
    assert.equal(call.env.AWS_PAGER, "");
    assert.throws(() => cliInvocation("--debug", [], env));
    assert.throws(() => productionHostCertWorld("us-east-1", "bad profile"));
    assert.equal(productionHostCertWorld("us-east-1", "gs-host-deploy").host.label, "aws-cli-ssm profile=gs-host-deploy");
  });
  test("RECON-1: the host transport's AWS surface is exactly SSM Run Command (AWS-RunShellScript) + its result, two EC2 describes and one ECS list", () => {
    const src = fs.readFileSync(path.join(SRC, "aws/deploy/hostcert/awsCliTransport.ts"), "utf8");
    const calls = [...src.matchAll(/\[\s*"(ssm|ec2|ecs|sts|iam|kms|dynamodb|s3|logs|cloudwatch|elbv2|cloudfront|autoscaling)",\s*"([a-z-]+)"/g)].map((m) => `${m[1]} ${m[2]}`);
    assert.deepEqual([...new Set(calls)].sort(), ["ec2 describe-addresses", "ec2 describe-instances", "ecs list-tasks", "ssm get-command-invocation", "ssm send-command"]);
    assert.equal((src.match(/"--document-name", "AWS-RunShellScript"/g) ?? []).length, 1);
    assert.ok(!/AWS-RunPowerShellScript|start-session|send-ssh-public-key|"--targets"/.test(src), "one instance by id, one document, no session");
  });
  test("evidence is create-once", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-ev-"));
    fs.writeFileSync(path.join(dir, evidenceFileOf("crash-restart", RUN)), "{}");
    assert.equal(await hostCertCommand(args("crash-restart", { "--evidence": dir }), noAws, host), 2);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  test("every scenario is listed with its property and disruption", () => {
    assert.deepEqual(Object.keys(SCENARIOS).sort(), ["crash-restart", "duplicate-fence", "duplicate-preflight", "graceful-stop", "reboot-restart", "replacement-after", "replacement-before"]);
    assert.equal(SCENARIOS["duplicate-preflight"].disruptive, false);
    for (const s of ["crash-restart", "reboot-restart", "duplicate-fence", "replacement-before", "replacement-after"] as const) assert.equal(SCENARIOS[s].quiet, true, s);
  });
});

/* ================================================================== */
describe("COST-2C: the runbook says which command certifies what -- and that the systemd item stays OPEN", () => {
  test("SINGLE_HOST_MIGRATION.md names every scenario, its GO, and the OPEN AL2023 item; the owner gate exists", () => {
    const book = fs.readFileSync(path.join(REPO, "infra/aws/SINGLE_HOST_MIGRATION.md"), "utf8");
    for (const s of Object.keys(SCENARIOS)) assert.ok(book.includes(s), s);
    const rows: ReadonlyArray<readonly [string, string]> = [["F7", "graceful-stop"], ["F8", "crash-restart"], ["F8", "reboot-restart"], ["F9a", "duplicate-preflight"], ["F9b", "duplicate-fence"]];
    for (const [f, scenario] of rows) assert.ok(book.split("\n").some((line) => line.startsWith(`| ${f} `) && line.includes(`\`${scenario}\``)), `${f} -> ${scenario}`);
    assert.match(book, /\*\*OPEN\*\* \| \*\*The AL2023 \/ systemd exit-status contract\*\*/);
    assert.match(book, /NOT EVALUATED until `host-cert duplicate-fence`/);
    assert.match(book, /GO COST-2C F9b duplicate-fence/);
    assert.ok(fs.existsSync(path.join(REPO, "infra/aws/single-host/run-cost2c-owner-gate.ps1")));
  });
});

/* ================================================================== */
describe("COST-2C: source guards", () => {
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [path.join(dir, e.name)] : []));
  const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");
  const code = (f: string) => fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  test("only awsCliTransport.ts spawns a process (execFile, never a shell) and takes the live brand", () => {
    const spawners = walk(path.join(SRC, "aws")).filter((f) => /child_process/.test(code(f))).map(rel);
    assert.deepEqual(spawners, ["aws/deploy/hostcert/awsCliTransport.ts"]);
    const t = code(path.join(SRC, "aws/deploy/hostcert/awsCliTransport.ts"));
    assert.ok(/execFile\("aws"/.test(t) && /shell: false/.test(t) && !/\bexec\(|spawn\(|shell: true/.test(t));
    const branders = walk(SRC).filter((f) => /LIVE\.add\(|takeLiveBrand/.test(code(f))).map(rel);
    assert.deepEqual(branders, ["aws/deploy/hostcert/awsCliTransport.ts"]);
  });
  test("the test support is reached by tests only; the hostcert code writes only the lock item; no --force anywhere", () => {
    const users = walk(SRC).filter((f) => /hostCertTestSupport/.test(code(f))).map(rel);
    assert.deepEqual(users, []);
    for (const f of walk(path.join(SRC, "aws/deploy/hostcert"))) {
      const c = code(f);
      if (rel(f) !== "aws/deploy/hostcert/drillLock.ts" && !rel(f).endsWith("TestSupport.ts")) assert.ok(!/PutItemCommand|UpdateItemCommand|DeleteItemCommand|TransactWrite|BatchWrite/.test(c), rel(f));
      assert.ok(!/--force/.test(c), `${rel(f)} has a --force`);
    }
    const lock = code(path.join(SRC, "aws/deploy/hostcert/drillLock.ts"));
    assert.ok(!/UpdateItemCommand|DeleteItemCommand|Transact/.test(lock), "the lock only Puts / Gets its one item");
    assert.equal((lock.match(/OPRUN#host-cert/g) ?? []).length, 1);
  });
  test("the drill lock item's attributes are exactly the operator role's PutItem grant (infra/aws/modules/app/iam.tf)", () => {
    const iam = fs.readFileSync(path.join(REPO, "infra/aws/modules/app/iam.tf"), "utf8");
    const m = /sid\s+=\s+"RoutingAndEvidence"[\s\S]*?values\s+=\s+\[([^\]]*)\]\s*\}\s*condition[\s\S]*?values\s+=\s+\[([^\]]*)\]/.exec(iam);
    assert.ok(m !== null);
    const allowed = new Set((m?.[2] ?? "").split(",").map((s) => s.trim().replace(/"/g, "")).filter((s) => s.length > 0));
    for (const a of ["pk", "sk", "fmt", "run", "task", "command", "subject", "note", "started_at", "tool", "build", "outcome", "detail", "at", "claim"]) assert.ok(allowed.has(a), a);
    assert.match(m?.[1] ?? "", /OPRUN#\*/);
  });
  test("nothing in the server runtime reads the drill lock or the host-cert code (never an authority)", () => {
    for (const f of walk(SRC)) {
      if (rel(f).startsWith("aws/deploy/") || rel(f) === "tools/awsDeploy.ts") continue;
      assert.ok(!/host-cert|hostcert/.test(code(f)), rel(f));
    }
  });
});
