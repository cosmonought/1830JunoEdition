// server/src/aws/deploy/staging/hostRoleProbe.test.ts
//
// PHASE 1 REMAINDER (SINGLE_HOST_MIGRATION.md F5 / F6): the host-role probes. Offline only -- no AWS, no host:
//
//   - the judge (`stage-probe host-role`) PASSES a complete F5 / F6 capture whose record is L6-6's own task-role probe,
//     run under the host role on the serving release, and REFUSES (FAIL / NOT EVALUATED, never PASS): the wrong principal
//     (AWS's AccessDenied naming the ECS task role, or the IMDS role not the host's), an ECS task's record, another
//     release or instance, a HOLD, a static credential, a truncated or corrupted capture, a foreign wrapper, an F5 run
//     that wrote, an F6 run on another partition or that left items behind, a slow or unverified KMS Sign, a record
//     carrying secret-shaped material, a refused run; the verdict is create-once;
//   - the REAL wrapper (infra/aws/single-host/host-role-probe.sh, with the REAL gs-lib.sh) on a fake host (fake docker /
//     systemctl / curl on PATH, Linux only): its output is judged PASS end to end; it runs the probe container exactly as
//     reviewed (the probe command, GS_STORAGE overridden, read-only, no env file, no port, no host network, disposable
//     writes only for F6); it never reads the IMDS credential document; it refuses a non-serving digest, a stopped server,
//     a HOLD, a static credential, the wrong role and a prod* environment before starting anything;
//   - static: gs-host.sh's role-probe sends only the reviewed wrapper and validated arguments; gs-host.ps1 keeps the
//     083d066 stderr fix (its regression and the role-probe regression are the ps1 tests named in the runbook).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { DeployDeps } from "../commands";
import { stageProbeCommand, type StagingDeps } from "./commands";
import { PROBE_FORMAT, recordLines, sha256Hex } from "./evidence";
import { HOST_ROLE_FILES, HOST_ROLE_PROBE_FORMAT, HOST_ROLE_WRAPPER, hostRoleName, judgeHostRoleCapture, wrapperSha256, type HostRoleExpect, type HostRoleProbe } from "./hostRoleProbe";
import { runIamProbe } from "./iamProbe";
import { KMS_LATENCY_BOUND_MS } from "./kmsProbe";

const REPO = path.resolve(__dirname, "../../../../../../.."); // dist/server/src/aws/deploy/staging -> the repository
const WRAPPER = path.join(REPO, HOST_ROLE_WRAPPER);
const GS_LIB = path.join(REPO, "infra/aws/modules/single-host/files/bin/gs-lib.sh");
const RUN = "phase1-f5f6-0001";
const INSTANCE = "i-01fe56536bf591382";
const DIGEST = `sha256:${"df".repeat(32)}`;
const BUILD = "sh1-083d066-arm64-r1";
const ACCOUNT = "111122223333";
const RUNTIME = `arn:aws:ssm:us-east-1:${ACCOUNT}:parameter/gs/staging/runtime/p1`;
const REGISTRY = `${ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com`;
const HOST_ROLE = hostRoleName("staging");

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "p1-role-"));

/* ------------------------------------------------------------------ */
/* The task-role probe's record (L6-6's own probes, run on fakes)       */
/* ------------------------------------------------------------------ */

/** A DynamoDB that enforces the host policy's shape (modules/single-host iam.tf) and names `role` in every denial. */
function enforcingDynamo(role: string) {
  const denied = (what: string) => Object.assign(new Error(`User: arn:aws:sts::${ACCOUNT}:assumed-role/${role}/${INSTANCE} is not authorized to perform: ${what}`), { name: "AccessDeniedException" });
  return {
    async send(command: { constructor: { name: string }; input: Record<string, any> }) {
      const name = command.constructor.name;
      if (name === "PutItemCommand") throw denied("dynamodb:PutItem");
      const items: Array<Record<string, any>> = command.input.TransactItems;
      const ledger = (t: string) => t.startsWith("arn:");
      const forbidden = items.some((it) => {
        const write = it.Put ?? it.Update ?? it.Delete;
        if (write === undefined) return false;
        const pk = String((it.Put?.Item ?? write.Key).pk.S);
        return ledger(write.TableName) ? it.Update !== undefined || it.Delete !== undefined || pk === "APPGEN" : pk === "SYSTEM";
      });
      if (forbidden) throw denied("dynamodb:TransactWriteItems");
      throw Object.assign(new Error("Transaction cancelled"), { name: "TransactionCanceledException", CancellationReasons: items.map((it) => ({ Code: it.ConditionCheck !== undefined ? "None" : "ConditionalCheckFailed" })) });
    },
  };
}

const kmsSection = (over: { ms?: number; verified?: boolean; identities?: boolean } = {}) => {
  const key = (k: string) => ({ opened: true, key: k, samples: Array.from({ length: 5 }, () => ({ ms: over.ms ?? 142, verified: over.verified ?? true, signature_bytes: 64 })) });
  return { status: "ran", results: { bound_ms: KMS_LATENCY_BOUND_MS, samples_per_key: 5, identities: { ok: over.identities ?? true, detail: "the relayer key controls the configured address; the settlement and admission keys are the configured public keys" }, keys: { relayer: key("a1b2c3d4e5f6"), settlement: key("b1b2c3d4e5f6"), admission: key("c1b2c3d4e5f6") } } };
};

const transactionsSection = (over: { remaining?: number; partition?: string } = {}) => ({
  status: "ran",
  partition: over.partition ?? `L6CERT#${RUN}`,
  results: {
    t1: { setup: { kind: "applied" }, probe: { kind: "refused", resend: false, reasons: ["ConditionalCheckFailed", "None"], old_v: [1] }, b_present: false },
    t2: { setup: { kind: "applied" }, a: { kind: "applied" }, b: { kind: "refused" }, final_v: 2, final_w: "a" },
    t3: { setup: { kind: "applied" }, rounds: 20, writers: 6, applied: 41, conflicts: 7, conflicts_classified_not_applied: 7, other: {}, final_n: 41 },
    t4: { setup: { kind: "applied" }, original: "applied", same_token_resend: { kind: "applied" }, new_token_control: { kind: "refused" }, final_v: 2, final_n: 1, mismatch: "IdempotentParameterMismatchException", mismatch_engine_class: "unknown", refused_original: "TransactionCanceledException", refused_resend: { kind: "refused" } },
    errors: [],
    cleanup: { deleted: 9, remaining: over.remaining ?? 0, left: over.remaining ? ["T3-N"] : [], errors: [] },
  },
});

interface RecordOptions {
  readonly probe?: HostRoleProbe;
  readonly role?: string;
  readonly kms?: unknown;
  readonly transactions?: unknown;
  readonly runner?: Record<string, unknown>;
  readonly startedAt?: string;
  readonly extra?: Record<string, unknown>;
}

async function taskRoleRecord(options: RecordOptions = {}): Promise<Record<string, unknown>> {
  const probe = options.probe ?? "kms";
  const dynamo = enforcingDynamo(options.role ?? HOST_ROLE) as never;
  const iam = await runIamProbe({ game: dynamo, ledger: dynamo }, { run: RUN, gameTable: "gs-staging-game-g1", ledgerTable: `arn:aws:dynamodb:us-east-1:${ACCOUNT}:table/gs-staging-ledger`, nonce: "0123456789abcdef0123456789abcdef" });
  const at = options.startedAt ?? new Date().toISOString();
  return {
    format: PROBE_FORMAT,
    probe: "task-role",
    run_id: RUN,
    environment: "staging",
    generation: 1,
    pool: "p1",
    started_at: at,
    finished_at: at,
    runner: { ecs_task: false, task_arn: null, build_id: BUILD, build_capabilities: { recovery: true }, runtime_parameter_matches_env: true, ...(options.runner ?? {}) },
    runtime_document_version: 7,
    sections: {
      iam: { status: "ran", ...iam },
      kms: options.kms ?? kmsSection(),
      transactions: options.transactions ?? (probe === "transactions" ? transactionsSection() : { status: "not-run", reason: `--disposable-writes L6CERT#${RUN} was not given` }),
      identity_state: { status: "not-bound" },
    },
    ...(options.extra ?? {}),
  };
}

/* ------------------------------------------------------------------ */
/* A capture shaped exactly as the wrapper prints it                    */
/* ------------------------------------------------------------------ */

const FACTS = (probe: HostRoleProbe): Array<[string, string]> => [
  ["probe", probe],
  ["run_id", RUN],
  ["digest", DIGEST],
  ["generation", "1"],
  ["pool", "p1"],
  ["wrapper_sha256", wrapperSha256(fs.readFileSync(WRAPPER, "utf8"))],
  ["environment", "staging"],
  ["runtime_parameter", RUNTIME],
  ["build_id", BUILD],
  ["server_state", "active"],
  ["hold", "none"],
  ["static_credentials", "none"],
  ["release_digest", DIGEST],
  ["running_digest", DIGEST],
  ["image", `${REGISTRY}/gs-staging-server@${DIGEST}`],
  ["image_platform", "linux/arm64"],
  ["instance_id", INSTANCE],
  ["instance_profile", `arn:aws:iam::${ACCOUNT}:instance-profile/${HOST_ROLE}`],
  ["instance_role", HOST_ROLE],
  ["probe_started_at", new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, "Z")],
  ["probe_finished_at", new Date(Date.now() + 60_000).toISOString().replace(/\.\d{3}Z$/, "Z")],
  ["probe_exit", "0"],
  ["probe_container_left", "none"],
];

/** Re-fold the image's record lines exactly as the wrapper does (one base64 string, 512-character pieces, same SHA-256). */
function refold(lines: readonly string[]): string[] {
  const parts = lines.map((l) => l.split(" "));
  const digest = parts[0][2];
  const b64 = parts.map((p) => p[3]).join("");
  const pieces = b64.match(/.{1,512}/g) ?? [];
  return pieces.map((piece, i) => `L6CERT/v1 ${i + 1}/${pieces.length} ${digest} ${piece}`);
}

function capture(record: unknown, options: { probe?: HostRoleProbe; facts?: Record<string, string | null>; end?: number | null; lines?: (l: string[]) => string[]; prefix?: string[] } = {}): string {
  const probe = options.probe ?? "kms";
  const facts = FACTS(probe).filter(([k]) => options.facts?.[k] !== null).map(([k, v]) => [k, options.facts?.[k] ?? v] as const);
  for (const [k, v] of Object.entries(options.facts ?? {})) if (v !== null && !facts.some(([fk]) => fk === k)) facts.push([k, v]);
  const lines = refold(recordLines(record));
  const out = [
    ...(options.prefix ?? [`gs-host: role-probe on ${INSTANCE} (command 0b2e7f00-1111-2222-3333-444455556666)`]),
    "GS-HOST-ROLE-PROBE BEGIN",
    ...facts.map(([k, v]) => `${k}=${v}`),
    `probe_out=stage-probe task-role ${RUN}: staging g1 pool p1; runtime document v7`,
    "probe_out=  iam: ran",
    ...(options.lines ?? ((l: string[]) => l))(lines),
    ...(options.end === null ? [] : [`GS-HOST-ROLE-PROBE END exit=${options.end ?? 0}`]),
  ];
  return `${out.join("\n")}\n`;
}

const expect = (probe: HostRoleProbe = "kms", over: Partial<HostRoleExpect> = {}): HostRoleExpect => ({ probe, run: RUN, environment: "staging", generation: 1, pool: "p1", instanceId: INSTANCE, digest: DIGEST, build: BUILD, wrapperSha256: wrapperSha256(fs.readFileSync(WRAPPER, "utf8")), ...over });
const failed = (j: { checks: ReadonlyArray<{ name: string; status: string; detail: string }> }) => j.checks.filter((c) => c.status !== "pass").map((c) => `${c.status} ${c.name}: ${c.detail}`).join("\n");

/* ------------------------------------------------------------------ */

describe("PHASE 1 REMAINDER F5 / F6: the host-role probe's judge", () => {
  test("F5 (kms) PASSES: the host role named by AWS itself, the three signing identities, every disposable Sign verified < 3 s, nothing written", async () => {
    const j = judgeHostRoleCapture(capture(await taskRoleRecord()), expect("kms"));
    assert.equal(j.verdict, "PASS", failed(j));
    const names = j.checks.map((c) => c.name).join("\n");
    for (const n of [/AWS names the host role as the caller/, /KMS: public keys = the configuration's/, /KMS relayer .*: Sign verified/, /KMS admission: Sign latency below 3000 ms/, /F5 wrote nothing/, /the host's probe, not an ECS task's/, /the reviewed wrapper ran/, /the running container is that release/]) assert.match(names, n);
    assert.deepEqual(j.measurements.kms_relayer, { max_ms: 142, samples: 5, key: "a1b2c3d4e5f6" });
    assert.equal(j.measurements.iam_probes, 13);
  });

  test("F6 (transactions) PASSES: T1-T4 on the disposable partition only, read back empty", async () => {
    const j = judgeHostRoleCapture(capture(await taskRoleRecord({ probe: "transactions" }), { probe: "transactions" }), expect("transactions"));
    assert.equal(j.verdict, "PASS", failed(j));
    assert.match(j.checks.map((c) => c.name).join("\n"), /only the disposable partition[\s\S]*T3 a conflict never applied anything[\s\S]*transactions: cleanup/);
    assert.deepEqual(j.measurements.t3, { conflicts: 7, applied: 41 });
    assert.equal(j.measurements.cleanup, 0);
  });

  test("the WRONG PRINCIPAL never passes: AWS's denials name the ECS task role, or the IMDS role is not the host's", async () => {
    const asTask = judgeHostRoleCapture(capture(await taskRoleRecord({ role: "gs-staging-app-task" })), expect("kms"));
    assert.equal(asTask.verdict, "FAIL");
    assert.match(failed(asTask), /AWS names the host role as the caller: the denials name \[gs-staging-app-task\], not gs-staging-host-app/);
    assert.match(failed(asTask), /denied-not-the-task-role: the denial names assumed-role\/gs-staging-app-task, not assumed-role\/gs-staging-host-app/);
    const imds = judgeHostRoleCapture(capture(await taskRoleRecord(), { facts: { instance_role: "gs-staging-operator" } }), expect("kms"));
    assert.equal(imds.verdict, "FAIL");
    assert.match(failed(imds), /the instance role: instance_role=gs-staging-operator, not gs-staging-host-app/);
    const profile = judgeHostRoleCapture(capture(await taskRoleRecord(), { facts: { instance_profile: `arn:aws:iam::${ACCOUNT}:instance-profile/other` } }), expect("kms"));
    assert.match(failed(profile), /is not the host's profile/);
    const ecs = judgeHostRoleCapture(capture(await taskRoleRecord({ runner: { ecs_task: true, task_arn: "arn:aws:ecs:us-east-1:111122223333:task/gs-staging/abc" } })), expect("kms"));
    assert.match(failed(ecs), /the host's probe, not an ECS task's: ecs_task true/);
    const creds = judgeHostRoleCapture(capture(await taskRoleRecord(), { facts: { static_credentials: "AWS_PROFILE" } }), expect("kms"));
    assert.match(failed(creds), /no static AWS credential on the host: static_credentials=AWS_PROFILE/);
  });

  test("the SERVING release on THIS host, only: another digest, build, instance, environment, a HOLD or a stopped server FAILS", async () => {
    const record = await taskRoleRecord();
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ running_digest: `sha256:${"aa".repeat(32)}` }, /the running container is that release/],
      [{ release_digest: `sha256:${"aa".repeat(32)}` }, /release\.env names that release/],
      [{ digest: `sha256:${"aa".repeat(32)}` }, /the release digest asked for/],
      [{ instance_id: "i-0aaaaaaaaaaaaaaaa" }, /the single host: instance_id=i-0aaaaaaaaaaaaaaaa/],
      [{ hold: "exit 3 fenced" }, /no HOLD/],
      [{ server_state: "inactive" }, /the game server is serving/],
      [{ probe_container_left: "present" }, /the probe container is gone/],
      [{ probe_exit: "2" }, /the probe exited cleanly/],
      [{ wrapper_sha256: "0".repeat(64) }, /the host ran a wrapper with sha256 0{64}, not the repository's/],
      [{ run_id: "another-run-01" }, /this run/],
    ];
    for (const [facts, pattern] of cases) {
      const j = judgeHostRoleCapture(capture(record, { facts }), expect("kms"));
      assert.equal(j.verdict, "FAIL", JSON.stringify(facts));
      assert.match(failed(j), pattern, JSON.stringify(facts));
    }
    assert.match(failed(judgeHostRoleCapture(capture(record), expect("kms", { build: "sh1-other" }))), /its build: build_id=sh1-083d066-arm64-r1, not sh1-other/);
    /* The repository's wrapper could not be read: never a PASS. */
    assert.equal(judgeHostRoleCapture(capture(record), expect("kms", { wrapperSha256: null })).verdict, "NOT EVALUATED");
  });

  test("a truncated capture is NOT EVALUATED; a corrupted or incomplete record inside a complete one FAILS", async () => {
    const record = await taskRoleRecord();
    assert.equal(judgeHostRoleCapture(capture(record, { end: null }), expect("kms")).verdict, "NOT EVALUATED");
    assert.equal(judgeHostRoleCapture("gs-host: role-probe on i-x\n", expect("kms")).verdict, "NOT EVALUATED");
    const twice = capture(record) + capture(record);
    assert.equal(judgeHostRoleCapture(twice, expect("kms")).verdict, "NOT EVALUATED");
    const corrupt = judgeHostRoleCapture(capture(record, { lines: (l) => l.map((x, i) => (i === 1 ? `${x.slice(0, -10)}${x.charAt(x.length - 10) === "Q" ? "R" : "Q"}${x.slice(-9)}` : x)) }), expect("kms"));
    assert.equal(corrupt.verdict, "FAIL");
    assert.match(failed(corrupt), /does not match its SHA-256/);
    const dropped = judgeHostRoleCapture(capture(record, { lines: (l) => l.filter((_, i) => i !== 2) }), expect("kms"));
    assert.match(failed(dropped), /record chunk 3 of \d+ is missing/);
    const none = judgeHostRoleCapture(capture(record, { lines: () => [] }), expect("kms"));
    assert.match(failed(none), /no L6CERT\/v1 record/);
  });

  test("a refused host run FAILS (it never ran the probe)", () => {
    const text = ["GS-HOST-ROLE-PROBE BEGIN", "probe=kms", `run_id=${RUN}`, "refused=the game server is not active: F5 / F6 probe the SERVING release (after step 13)", "GS-HOST-ROLE-PROBE END exit=93"].join("\n");
    const j = judgeHostRoleCapture(text, expect("kms"));
    assert.equal(j.verdict, "FAIL");
    assert.match(failed(j), /the host ran the probe: refused: the game server is not active/);
  });

  test("F5 and F6 each prove their own thing: a slow / unverified Sign, wrong identities, F5 that wrote, F6 on another partition or leaving items FAILS", async () => {
    const slow = judgeHostRoleCapture(capture(await taskRoleRecord({ kms: kmsSection({ ms: 3000 }) })), expect("kms"));
    assert.match(failed(slow), /KMS relayer: Sign latency below 3000 ms: max 3000 ms/);
    assert.match(failed(judgeHostRoleCapture(capture(await taskRoleRecord({ kms: kmsSection({ verified: false }) })), expect("kms"))), /Sign verified: 5 of 5 not verified/);
    assert.match(failed(judgeHostRoleCapture(capture(await taskRoleRecord({ kms: kmsSection({ identities: false }) })), expect("kms"))), /public keys = the configuration's/);
    assert.match(failed(judgeHostRoleCapture(capture(await taskRoleRecord({ kms: { status: "not-run", reason: "escrow is null (no KMS keys)" } })), expect("kms"))), /KMS: not run/);
    const wrote = judgeHostRoleCapture(capture(await taskRoleRecord({ transactions: transactionsSection() })), expect("kms"));
    assert.match(failed(wrote), /F5 wrote nothing: the transaction section is ran on L6CERT#/);
    const other = judgeHostRoleCapture(capture(await taskRoleRecord({ probe: "transactions", transactions: transactionsSection({ partition: "GAME#JUNO-1" }) }), { probe: "transactions" }), expect("transactions"));
    assert.match(failed(other), /only the disposable partition: the probe names partition GAME#JUNO-1/);
    const left = judgeHostRoleCapture(capture(await taskRoleRecord({ probe: "transactions", transactions: transactionsSection({ remaining: 1 }) }), { probe: "transactions" }), expect("transactions"));
    assert.match(failed(left), /transactions: cleanup: remaining 1 \[T3-N\]/);
    const notRun = judgeHostRoleCapture(capture(await taskRoleRecord({ probe: "transactions", transactions: { status: "not-run", reason: "x" } }), { probe: "transactions" }), expect("transactions"));
    assert.match(failed(notRun), /transactions: not run/);
  });

  test("a record carrying secret-shaped material is refused (never written)", async () => {
    const j = judgeHostRoleCapture(capture(await taskRoleRecord({ extra: { note: "AKIAABCDEFGHIJKLMNOP" } })), expect("kms"));
    assert.equal(j.verdict, "FAIL");
    assert.match(failed(j), /the record carries nothing secret: an AWS access key id/);
  });
});

describe("PHASE 1 REMAINDER F5 / F6: `stage-probe host-role` writes the evidence (create-once) and exits 0 / 1 / 3", () => {
  const run = async (dir: string, captureFile: string, probe: HostRoleProbe = "kms", extra: string[] = []) => {
    const out: string[] = [];
    const deps = { now: () => Date.parse("2026-10-03T12:00:00Z"), out: (l: string) => out.push(l) } as unknown as DeployDeps;
    const staging = { env: {}, monotonic: () => 0, edge: {} as never, repository: REPO } as StagingDeps;
    const argv = ["host-role", "--probe", probe, "--run-id", RUN, "--evidence", dir, "--capture", captureFile, "--environment", "staging", "--generation", "1", "--pool", "p1", "--instance-id", INSTANCE, "--digest", DIGEST, "--build", BUILD, ...extra];
    const code = await stageProbeCommand(argv, deps, staging).catch((e: Error) => e.message);
    return { code, out };
  };

  test("PASS writes the record and the verdict; a second judgement of the same run is refused; UTF-16 (PowerShell 5.1 Tee) is read", async () => {
    const dir = tmp();
    const file = path.join(tmp(), "f5.txt");
    const text = capture(await taskRoleRecord());
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]));
    const { code, out } = await run(dir, file);
    assert.equal(code, 0, out.join("\n"));
    assert.match(out[out.length - 1], /^HOST-ROLE PROBE F5 KMS: PASS -- /);
    const verdict = JSON.parse(fs.readFileSync(path.join(dir, HOST_ROLE_FILES.verdict("kms")), "utf8"));
    assert.equal(verdict.format, HOST_ROLE_PROBE_FORMAT);
    assert.deepEqual([verdict.proof, verdict.verdict, verdict.instance_id, verdict.digest], ["F5", "PASS", INSTANCE, DIGEST]);
    assert.equal(verdict.capture_sha256, sha256Hex(fs.readFileSync(file)));
    const record = JSON.parse(fs.readFileSync(path.join(dir, HOST_ROLE_FILES.record("kms")), "utf8"));
    assert.equal(record.probe, "task-role");
    assert.match(String((await run(dir, file)).code), /already exists .* a verdict is never overwritten/);
  });

  test("FAIL exits 1 and NOT EVALUATED exits 3; the arguments are validated", async () => {
    const dir = tmp();
    const bad = path.join(tmp(), "f6.txt");
    fs.writeFileSync(bad, capture(await taskRoleRecord({ probe: "transactions", role: "gs-staging-app-task" }), { probe: "transactions" }));
    assert.equal((await run(dir, bad, "transactions")).code, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, HOST_ROLE_FILES.verdict("transactions")), "utf8")).verdict, "FAIL");
    const truncated = path.join(tmp(), "t.txt");
    fs.writeFileSync(truncated, capture(await taskRoleRecord(), { end: null }));
    assert.equal((await run(tmp(), truncated)).code, 3);
    assert.match(String((await run(tmp(), truncated, "all" as HostRoleProbe)).code), /--probe is kms \(F5\) or transactions \(F6\)/);
    assert.match(String((await run(tmp(), path.join(tmp(), "missing.txt"))).code), /--capture is the file/);
    const { code } = await (async () => {
      const out: string[] = [];
      const deps = { now: () => 0, out: (l: string) => out.push(l) } as unknown as DeployDeps;
      return { code: await stageProbeCommand(["host-role", "--probe", "kms", "--run-id", RUN, "--evidence", tmp(), "--capture", truncated, "--environment", "staging", "--generation", "1", "--pool", "p1", "--instance-id", INSTANCE, "--digest", "sha256:XYZ", "--build", BUILD], deps, { env: {}, monotonic: () => 0, edge: {} as never, repository: REPO }).catch((e: Error) => e.message) };
    })();
    assert.match(String(code), /--digest is the SERVING release's/);
  });
});

/* ------------------------------------------------------------------ */
/* The REAL wrapper on a fake host                                      */
/* ------------------------------------------------------------------ */

const LINUX = process.platform === "linux" && spawnSync("bash", ["-c", "command -v flock && command -v sha256sum && command -v fold && command -v awk"], { encoding: "utf8" }).status === 0;

interface FakeHost {
  readonly dir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly runArgs: () => string[] | null;
  readonly curlUrls: () => string[];
  readonly dockerCalls: () => string[];
}

function fakeHost(options: { probeOut: string; role?: string; running?: string; release?: string; state?: string; hold?: boolean; creds?: boolean; environment?: string; probeExit?: number; leftover?: boolean }): FakeHost {
  const dir = tmp();
  const bin = path.join(dir, "bin");
  const etc = path.join(dir, "etc");
  fs.mkdirSync(bin);
  fs.mkdirSync(etc);
  fs.mkdirSync(path.join(dir, "state"));
  fs.mkdirSync(path.join(dir, "rootaws"));
  const environment = options.environment ?? "staging";
  fs.writeFileSync(path.join(etc, "host.env"), [`GS_ENVIRONMENT=${environment}`, "GS_REGION=us-east-1", "GS_ARCH=arm64", `GS_ECR_REGISTRY=${REGISTRY}`, `GS_ECR_REPOSITORY=gs-${environment}-server`, `GS_LOG_GROUP=/gs/${environment}/host`, "GS_CONTAINER_PORT=8917", ""].join("\n"));
  fs.writeFileSync(path.join(etc, "server.env"), ["GS_MODE=production", "GS_STORAGE=aws", `GS_AWS_CONFIG_PARAMETER=${RUNTIME}`, "PORT=8917", "GS_TRUSTED_PROXY_HOPS=2", ...(options.creds === true ? ["AWS_PROFILE=leak"] : []), ""].join("\n"));
  fs.writeFileSync(path.join(etc, "release.env"), `GS_IMAGE_DIGEST=${options.release ?? DIGEST}\nBUILD_ID=${BUILD}\nGS_MEASURE=1\n`);
  if (options.hold === true) fs.writeFileSync(path.join(dir, "state", "hold"), "exit 3\n");
  if (options.leftover === true) fs.writeFileSync(path.join(dir, "leftover"), "");
  fs.writeFileSync(path.join(dir, "probe-out"), options.probeOut);
  const script = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  script(
    "docker",
    `printf '%s\\n' "$*" >> "$FAKE_DIR/docker.log"
case "$1 $2" in
  "container inspect") last="\${@: -1}"
    if [ "$last" = gs-server ]; then echo "sha256:0123"; exit 0; fi
    [ -e "$FAKE_DIR/leftover" ] && { echo '[]'; exit 0; }; exit 1 ;;
  "image inspect") case "$4" in *RepoDigests*) echo "${REGISTRY}/gs-${environment}-server@${options.running ?? DIGEST}" ;; *Os*) echo "linux/arm64" ;; esac; exit 0 ;;
  "run --rm") for a in "$@"; do printf '%s\\n' "$a"; done > "$FAKE_DIR/run-args"; cat "$FAKE_DIR/probe-out"; echo "probe stderr" >&2; exit ${options.probeExit ?? 0} ;;
esac
exit 1`,
  );
  script("systemctl", `[ "$1 $2" = "is-active gs-server.service" ] && { echo "${options.state ?? "active"}"; [ "${options.state ?? "active"}" = active ]; exit $?; }\nexit 1`);
  script(
    "curl",
    `url=""; for a in "$@"; do case "$a" in http://* | https://*) url="$a" ;; esac; done; printf '%s\\n' "$url" >> "$FAKE_DIR/curl.log"
case "$url" in
  */latest/api/token) echo tok ;;
  */meta-data/instance-id) echo ${INSTANCE} ;;
  */meta-data/iam/info) echo '{"Code":"Success","InstanceProfileArn":"arn:aws:iam::${ACCOUNT}:instance-profile/${options.role ?? HOST_ROLE}","InstanceProfileId":"AIPAEXAMPLE"}' ;;
  */meta-data/iam/security-credentials/) echo ${options.role ?? HOST_ROLE} ;;
  *) exit 22 ;;
esac`,
  );
  const env: NodeJS.ProcessEnv = { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, GS_TEST: "1", GS_TEST_LIB: GS_LIB, GS_ETC: etc, GS_LOCK: path.join(dir, "lock"), GS_STATE_DIR: path.join(dir, "state"), GS_ROOT_AWS_DIR: path.join(dir, "rootaws"), GS_IMDS: "http://imds.invalid", FAKE_DIR: dir, HOME: dir };
  const read = (f: string) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter((l) => l !== "") : []);
  return { dir, env, runArgs: () => (fs.existsSync(path.join(dir, "run-args")) ? read("run-args") : null), curlUrls: () => read("curl.log"), dockerCalls: () => read("docker.log") };
}

const runWrapper = (host: FakeHost, args: string[]) => spawnSync("bash", [WRAPPER, ...args], { env: host.env, encoding: "utf8", timeout: 60_000 });

describe("PHASE 1 REMAINDER F5 / F6: the REAL host-role-probe.sh (with the real gs-lib.sh) on a fake host", { skip: LINUX ? false : "Linux with flock / sha256sum / fold / awk only (the wrapper runs on the AL2023 host)" }, () => {
  const probeOut = async (probe: HostRoleProbe) => `stage-probe task-role ${RUN}: staging g1 pool p1; runtime document v7\n  iam: ran\n  kms: ran\n  transactions: ${probe === "transactions" ? "ran" : "not-run"}\n${recordLines(await taskRoleRecord({ probe })).join("\n")}\n`;

  test("F5 end to end: the wrapper's own output is judged PASS; the probe container is exactly the reviewed one", async () => {
    const host = fakeHost({ probeOut: await probeOut("kms") });
    const r = runWrapper(host, [DIGEST, RUN, "kms", "1", "p1"]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const j = judgeHostRoleCapture(r.stdout, expect("kms"));
    assert.equal(j.verdict, "PASS", `${failed(j)}\n${r.stdout}`);
    assert.ok(r.stdout.split("\n").filter((l) => l.startsWith("L6CERT/v1 ")).every((l) => l.length <= 512 + 100), "the record is re-folded into short lines");
    assert.match(r.stdout, /^record_bytes=\d+$/m);
    const args = host.runArgs() as string[];
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    assert.deepEqual(args.slice(0, 4), ["run", "--rm", "--name", `gs-role-probe-${RUN}`]);
    for (const flag of ["--init", "--read-only", "--security-opt", "--cap-drop", "--pids-limit", "--memory"]) assert.ok(args.includes(flag), flag);
    assert.equal(at("--user"), "node");
    assert.equal(at("--cap-drop"), "ALL");
    assert.equal(at("--log-driver"), "none");
    const envs = args.flatMap((a, i) => (a === "-e" ? [args[i + 1]] : []));
    assert.deepEqual(envs, ["GS_STORAGE=l6-6-probe-not-a-server", `GS_AWS_CONFIG_PARAMETER=${RUNTIME}`, `BUILD_ID=${BUILD}`], "ONLY the storage override, the runtime document and the build: no credential, no env file");
    for (const forbidden of ["--env-file", "-p", "--publish", "--network", "--net", "--privileged", "-v", "--volume", "--mount", "--entrypoint", "--restart", "-d", "--detach"]) assert.ok(!args.includes(forbidden), `${forbidden} is never passed`);
    const image = args.indexOf(`${REGISTRY}/gs-staging-server@${DIGEST}`);
    assert.ok(image > 0, "the serving release BY DIGEST");
    assert.deepEqual(args.slice(image + 1), ["node", "dist/server/src/tools/awsDeploy.js", "stage-probe", "task-role", "--run-id", RUN, "--runtime-parameter", RUNTIME, "--environment", "staging", "--generation", "1", "--pool", "p1", "--kms-samples", "5"], "F5 sends no --disposable-writes");
    assert.ok(!host.dockerCalls().some((c) => /^(pull|rm|kill|stop|exec)\b/.test(c)), "nothing is pulled, removed, killed, stopped or exec'd");
  });

  test("F6 end to end: --disposable-writes L6CERT#<run> and nothing else; judged PASS", async () => {
    const host = fakeHost({ probeOut: await probeOut("transactions") });
    const r = runWrapper(host, [DIGEST, RUN, "transactions", "1", "p1"]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(judgeHostRoleCapture(r.stdout, expect("transactions")).verdict, "PASS", r.stdout);
    const args = host.runArgs() as string[];
    assert.deepEqual(args.slice(-2), ["--disposable-writes", `L6CERT#${RUN}`]);
  });

  test("the IMDS credential document is NEVER fetched (only the role's name from the listing)", async () => {
    const host = fakeHost({ probeOut: await probeOut("kms") });
    runWrapper(host, [DIGEST, RUN, "kms", "1", "p1"]);
    const urls = host.curlUrls();
    assert.ok(urls.some((u) => u.endsWith("/meta-data/iam/security-credentials/")));
    assert.ok(!urls.some((u) => /security-credentials\/[^/]+$/.test(u)), urls.join("\n"));
    assert.ok(urls.every((u) => u.startsWith("http://imds.invalid/latest/")), "only the instance metadata service");
  });

  test("REFUSES before starting anything: a non-serving digest, a stopped server, a HOLD, a static credential, the wrong role, prod*, a leftover probe, bad arguments", async () => {
    const out = await probeOut("kms");
    const cases: Array<[Parameters<typeof fakeHost>[0], string[], RegExp]> = [
      [{ probeOut: out, running: `sha256:${"aa".repeat(32)}` }, [DIGEST, RUN, "kms", "1", "p1"], /refused=the digest is not the serving release/],
      [{ probeOut: out, release: `sha256:${"aa".repeat(32)}` }, [DIGEST, RUN, "kms", "1", "p1"], /refused=the digest is not the serving release/],
      [{ probeOut: out, state: "inactive" }, [DIGEST, RUN, "kms", "1", "p1"], /refused=the game server is not active/],
      [{ probeOut: out, hold: true }, [DIGEST, RUN, "kms", "1", "p1"], /refused=a HOLD is present/],
      [{ probeOut: out, creds: true }, [DIGEST, RUN, "kms", "1", "p1"], /static_credentials=AWS_PROFILE\nrefused=a static AWS credential source/],
      [{ probeOut: out, role: "gs-staging-app-task" }, [DIGEST, RUN, "kms", "1", "p1"], /refused=the instance role is gs-staging-app-task, not gs-staging-host-app/],
      [{ probeOut: out, environment: "prod" }, [DIGEST, RUN, "kms", "1", "p1"], /refused=the host-role probe never runs in a prod\* environment/],
      [{ probeOut: out, leftover: true }, [DIGEST, RUN, "kms", "1", "p1"], /refused=a container gs-role-probe-.* already exists/],
      [{ probeOut: out }, [DIGEST, "BAD;id", "kms", "1", "p1"], /refused=the run id must match/],
      [{ probeOut: out }, [DIGEST, RUN, "all", "1", "p1"], /refused=the probe is kms \(F5\) or transactions \(F6\)/],
      [{ probeOut: out }, [DIGEST, RUN, "kms", "1", "p1;id"], /refused=the pool must match/],
      [{ probeOut: out }, ["sha256:x", RUN, "kms", "1", "p1"], /refused=usage/],
    ];
    for (const [options, args, pattern] of cases) {
      const host = fakeHost(options);
      const r = runWrapper(host, args);
      assert.notEqual(r.status, 0, JSON.stringify(options));
      assert.match(r.stdout, pattern, `${JSON.stringify(options)}\n${r.stdout}`);
      assert.match(r.stdout, /GS-HOST-ROLE-PROBE END exit=\d+\n$/, "framed");
      assert.equal(host.runArgs(), null, `nothing was started: ${JSON.stringify(options)}`);
      assert.equal(judgeHostRoleCapture(r.stdout, expect("kms")).verdict === "PASS", false);
    }
  });

  test("a probe that failed or printed no record ends framed and is never a PASS", async () => {
    const host = fakeHost({ probeOut: "NOT RECORDED: the record would carry an AWS access key id\n", probeExit: 1 });
    const r = runWrapper(host, [DIGEST, RUN, "kms", "1", "p1"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /probe_out=NOT RECORDED[\s\S]*record_lines=0[\s\S]*GS-HOST-ROLE-PROBE END exit=1\n$/);
    assert.equal(judgeHostRoleCapture(r.stdout, expect("kms")).verdict, "FAIL");
  });
});

describe("PHASE 1 REMAINDER F5 / F6: the operator wrappers (static)", () => {
  const sh = fs.readFileSync(path.join(REPO, "infra/aws/single-host/gs-host.sh"), "utf8");
  const ps1 = fs.readFileSync(path.join(REPO, "infra/aws/single-host/gs-host.ps1"), "utf8");
  const wrapper = fs.readFileSync(WRAPPER, "utf8");

  test("gs-host.sh role-probe: validates every argument and sends only the reviewed wrapper (no quote in the remote line)", () => {
    const block = /role-probe\)\n([\s\S]*?);;\n/.exec(sh)?.[1] ?? "";
    for (const re of ["^sha256:[0-9a-f]{64}$", "^[a-z0-9][a-z0-9-]{5,39}$", "kms | transactions", "^[1-9][0-9]{0,3}$", "^[a-z][a-z0-9-]{0,15}$", 'host-role-probe.sh" | base64']) assert.ok(block.includes(re), re);
    const remote = /^\s*remote="(.*\$script.*)" ;;$/m.exec(sh)?.[1] ?? "";
    assert.equal(remote, "d=\\$(mktemp -d) && printf %s $script | base64 -d > \\$d/p && bash \\$d/p $digest $run $probe $generation $pool; rc=\\$?; rm -rf \\$d; exit \\$rc");
    /* A live run through the real sh wrapper's parsing, aws stubbed: a hostile argument is refused before anything is sent. */
    if (LINUX) {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, "aws"), `#!/usr/bin/env bash\necho "$*" >> ${dir}/aws.log\nexit 1\n`, { mode: 0o755 });
      for (const bad of [["role-probe", INSTANCE, DIGEST, "run;reboot", "kms", "1", "p1"], ["role-probe", INSTANCE, DIGEST, RUN, "kms", "1", "p1$(id)"], ["role-probe", INSTANCE, DIGEST, RUN]]) {
        const r = spawnSync("bash", [path.join(REPO, "infra/aws/single-host/gs-host.sh"), ...bad], { env: { PATH: `${dir}:${process.env.PATH ?? ""}` }, encoding: "utf8" });
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /gs-host: REFUSED/);
      }
      assert.ok(!fs.existsSync(path.join(dir, "aws.log")), "aws was never called");
    }
  });

  test("gs-host.ps1 keeps the 083d066 multiline-stderr fix, and role-probe checks its arguments case-exactly", () => {
    for (const line of [
      "  $errText = (@($err) -join [Environment]::NewLine).Trim()",
      "  if ($errText -and $errText -ne 'None') {",
      '    try { Write-Warning -Message $errText } catch { try { Write-Host "gs-host: host stderr:$([Environment]::NewLine)$errText" } catch { } }',
      "  if ($status -ne 'Success') { throw \"gs-host: REFUSED: the host command ended $status.\" }",
    ])
      assert.ok(ps1.includes(line), line);
    assert.ok(ps1.indexOf("$errText = ") < ps1.indexOf("if ($status -ne 'Success')"), "the status check still follows the stderr rendering");
    assert.ok(!/Write-Warning \$err\b(?!Text)/.test(ps1), "never Write-Warning of the raw pipeline array");
    assert.match(ps1, /ValidateSet\('status', 'deploy', 'rollback', 'stop', 'measure-report', 'arm64-smoke', 'role-probe'\)/);
    assert.match(ps1, /\$RunId -cnotmatch '\^\[a-z0-9\]\[a-z0-9-\]\{5,39\}\$'/);
    assert.match(ps1, /\$remote = "d=`\$\(mktemp -d\) && printf %s \$probeScript \| base64 -d > `\$d\/p && bash `\$d\/p \$Digest \$RunId \$Probe \$Generation \$Pool; rc=`\$\?; rm -rf `\$d; exit `\$rc"/);
    for (const test of ["gs-host-stderr.test.ps1", "gs-host-role-probe.test.ps1"]) assert.ok(fs.existsSync(path.join(REPO, "infra/aws/single-host/tests", test)), test);
  });

  test("the wrapper: one docker run (the probe), the instance role only, the serving release only, refusals framed", () => {
    assert.equal((wrapper.match(/^docker run /gm) ?? []).length, 1);
    assert.ok(!/docker (pull|rm|kill|stop|exec|cp)\b/.test(wrapper.replace(/#.*$/gm, "")), "the wrapper never pulls, removes, kills, stops, execs or copies");
    const run = /^docker run [\s\S]*?2>"\$work\/err"$/m.exec(wrapper)?.[0] ?? "";
    assert.ok(run.length > 0, "the docker run block");
    for (const flag of ["--env-file", "--network", "--net=", "--privileged", " -v ", "--volume", "--mount", " -p ", "--publish", "--entrypoint", "--restart", " -d ", "--detach"]) assert.ok(!run.includes(flag), flag);
    assert.match(wrapper, /-e GS_STORAGE=l6-6-probe-not-a-server/);
    assert.ok(!/security-credentials\/\$|security-credentials\/"\$/.test(wrapper), "never the credential document");
    for (const guard of ["take_lock", "require_root", "static_credentials", "running_digest", "hold_file", "prod*)", 'refuse 98 "the probe\'s record ($bytes bytes) exceeds the SSM output budget']) assert.ok(wrapper.includes(guard), guard);
    assert.ok(!wrapper.includes("\r"), "LF only (it is sent byte for byte)");
  });

  test("modules/single-host is untouched by this tooling (the wrapper is sent, never installed)", () => {
    const r = spawnSync("git", ["-C", REPO, "diff", "--name-only", "083d0668556c05a84eb8b3e5befc4e973544aa9a", "--", "infra/aws/modules/single-host"], { encoding: "utf8" });
    if (r.status !== 0) return; // not a git checkout with the base commit (an exported tree): the owner gate's own diff covers it
    assert.equal(r.stdout.trim(), "", r.stdout);
  });
});
